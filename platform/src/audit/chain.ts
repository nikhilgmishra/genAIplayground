/**
 * Pure hash-chain primitives shared by the writer, shipper and verifier.
 *
 * hash = sha256(canonical JSON of the event without its `hash` field). Each event
 * carries the previous event's hash (`prevHash`), so rewriting or deleting any
 * event breaks every later link. Hashing proves integrity of what is present; it
 * does NOT prove completeness — see verifier.ts (reconcileCounts, ingestion gaps).
 */
import { AUDIT_SCHEMA_VERSION, AuditEvent, AuditManifest } from "../protocol/index.js";
import type { AuditEvent as AuditEventType, AuditEventInput, AuditManifest as AuditManifestType } from "../protocol/index.js";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";

export type UnhashedAuditEvent = Omit<AuditEventType, "hash">;

export function computeEventHash(event: UnhashedAuditEvent | AuditEventType): string {
  const { hash: _ignored, ...rest } = event as AuditEventType;
  return sha256Hex(canonicalJson(rest));
}

export interface ChainPosition {
  sourceStream: string;
  sequence: number;
  prevHash: string | null;
}

/** Assembles and hashes the next event of a stream. Validates the result strictly. */
export function buildChainedEvent(input: AuditEventInput, eventId: string, pos: ChainPosition): AuditEventType {
  const unhashed: UnhashedAuditEvent = {
    ...input,
    eventId,
    schemaVersion: AUDIT_SCHEMA_VERSION,
    sourceStream: pos.sourceStream,
    sequence: pos.sequence,
    prevHash: pos.prevHash,
  };
  return AuditEvent.parse({ ...unhashed, hash: computeEventHash(unhashed) });
}

/** NDJSON batch: one canonical JSON event per line, in sequence order, newline terminated. */
export function toNdjson(events: readonly AuditEventType[]): string {
  return events.map((e) => `${canonicalJson(e)}\n`).join("");
}

export const batchDigestOf = (ndjson: string): string => sha256Hex(ndjson);

const SEQ_PAD = 12;
export const padSequence = (n: number): string => String(n).padStart(SEQ_PAD, "0");

/** Deterministic object key: `<stream>/<firstSeq>-<lastSeq>.ndjson` (zero padded for ordered listing). */
export const objectKeyFor = (stream: string, firstSequence: number, lastSequence: number): string =>
  `${stream}/${padSequence(firstSequence)}-${padSequence(lastSequence)}.ndjson`;

export const OBJECT_KEY_RE = /^([a-z0-9_.-]{3,64})\/(\d{12})-(\d{12})\.ndjson$/;

export function parseObjectKey(key: string): { stream: string; firstSequence: number; lastSequence: number } | null {
  const m = OBJECT_KEY_RE.exec(key);
  if (!m || !m[1] || !m[2] || !m[3] || m[1].includes("..")) return null;
  return { stream: m[1], firstSequence: Number(m[2]), lastSequence: Number(m[3]) };
}

/** Builds the tamper-evident manifest for a contiguous batch of one stream. */
export function buildManifest(
  events: readonly AuditEventType[],
  meta: { manifestId: string; createdAt: string },
): { manifest: AuditManifestType; ndjson: string } {
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) throw new RangeError("AUDIT_BATCH_EMPTY");
  const ndjson = toNdjson(events);
  const manifest = AuditManifest.parse({
    manifestId: meta.manifestId,
    sourceStream: first.sourceStream,
    firstSequence: first.sequence,
    lastSequence: last.sequence,
    eventCount: events.length,
    firstPrevHash: first.prevHash,
    lastHash: last.hash,
    batchDigest: batchDigestOf(ndjson),
    createdAt: meta.createdAt,
    objectKey: objectKeyFor(first.sourceStream, first.sequence, last.sequence),
  });
  return { manifest, ndjson };
}

export type ParsedNdjsonLine = { ok: true; event: AuditEventType } | { ok: false; lineNumber: number };

/** Parses an NDJSON batch strictly; invalid lines are reported by position only (no content). */
export function parseNdjson(ndjson: string): ParsedNdjsonLine[] {
  if (ndjson.length === 0) return [];
  const body = ndjson.endsWith("\n") ? ndjson.slice(0, -1) : ndjson;
  return body.split("\n").map((line, i) => {
    try {
      const parsed = AuditEvent.safeParse(JSON.parse(line));
      if (!parsed.success) return { ok: false, lineNumber: i + 1 };
      // Non-canonical serializations are rejected: the batch must be byte-reproducible.
      if (canonicalJson(parsed.data) !== line) return { ok: false, lineNumber: i + 1 };
      return { ok: true, event: parsed.data };
    } catch {
      return { ok: false, lineNumber: i + 1 };
    }
  });
}

export type ChainFindingCode =
  | "EVENT_SCHEMA_INVALID"
  | "STREAM_MISMATCH"
  | "HASH_MISMATCH"
  | "SEQUENCE_GAP"
  | "SEQUENCE_OUT_OF_ORDER"
  | "PREV_HASH_MISMATCH";

export interface ChainFinding {
  code: ChainFindingCode;
  sequence: number | null;
  /** For gaps: the sequence that was expected next. */
  expectedSequence?: number;
  eventId?: string;
}

export interface ChainCheckResult {
  findings: ChainFinding[];
  checked: number;
  lastSequence: number | null;
  lastHash: string | null;
}

/**
 * Verifies a contiguous run of one stream: recomputed hashes, sequence continuity
 * and prevHash links, starting from an expected position (sequence 1 / null hash
 * for a full stream, or a purge watermark / previous manifest).
 */
export function verifyChain(
  events: readonly AuditEventType[],
  start: { sourceStream: string; expectedSequence: number; expectedPrevHash: string | null },
): ChainCheckResult {
  const findings: ChainFinding[] = [];
  let expectedSeq = start.expectedSequence;
  let expectedPrev = start.expectedPrevHash;
  let lastSequence: number | null = null;
  let lastHash: string | null = null;
  for (const raw of events) {
    const parsed = AuditEvent.safeParse(raw);
    if (!parsed.success) {
      findings.push({ code: "EVENT_SCHEMA_INVALID", sequence: typeof raw?.sequence === "number" ? raw.sequence : null });
      continue;
    }
    const e = parsed.data;
    if (e.sourceStream !== start.sourceStream) findings.push({ code: "STREAM_MISMATCH", sequence: e.sequence, eventId: e.eventId });
    if (computeEventHash(e) !== e.hash) findings.push({ code: "HASH_MISMATCH", sequence: e.sequence, eventId: e.eventId });
    if (e.sequence > expectedSeq) {
      findings.push({ code: "SEQUENCE_GAP", sequence: e.sequence, expectedSequence: expectedSeq, eventId: e.eventId });
    } else if (e.sequence < expectedSeq) {
      findings.push({ code: "SEQUENCE_OUT_OF_ORDER", sequence: e.sequence, expectedSequence: expectedSeq, eventId: e.eventId });
    }
    // The link is checked against the previous event actually present, so a gap
    // produces both a SEQUENCE_GAP and (normally) a PREV_HASH_MISMATCH.
    if (e.prevHash !== expectedPrev) findings.push({ code: "PREV_HASH_MISMATCH", sequence: e.sequence, eventId: e.eventId });
    expectedSeq = Math.max(expectedSeq, e.sequence + 1);
    expectedPrev = e.hash;
    lastSequence = e.sequence;
    lastHash = e.hash;
  }
  return { findings, checked: events.length, lastSequence, lastHash };
}
