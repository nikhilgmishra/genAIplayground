import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../protocol/index.js";
import { canonicalJson } from "../shared/canonical.js";
import { FakeClock } from "../shared/clock.js";
import {
  batchDigestOf,
  buildChainedEvent,
  buildManifest,
  computeEventHash,
  objectKeyFor,
  parseNdjson,
  parseObjectKey,
  toNdjson,
  verifyChain,
} from "./chain.js";
import { normalizeAuditInput } from "./schema.js";
import { sampleAuditInput } from "./testing.js";

const STREAM = "actions.synth-instance-1";

function chainOf(n: number): AuditEvent[] {
  const clock = new FakeClock();
  const events: AuditEvent[] = [];
  let prev: string | null = null;
  for (let i = 1; i <= n; i++) {
    clock.advanceSeconds(1);
    const e = buildChainedEvent(normalizeAuditInput(sampleAuditInput(clock)), `aud_synthEvent${String(i).padStart(10, "x")}`, {
      sourceStream: STREAM,
      sequence: i,
      prevHash: prev,
    });
    events.push(e);
    prev = e.hash;
  }
  return events;
}

const start = { sourceStream: STREAM, expectedSequence: 1, expectedPrevHash: null };

describe("audit hash chain primitives", () => {
  it("[SPEC-13.4] hash is sha256 over canonical JSON of the event without its hash field", () => {
    const [e] = chainOf(1);
    const { hash, ...rest } = e!;
    expect(hash).toBe(computeEventHash(rest));
    expect(computeEventHash(e!)).toBe(hash);
    // key order does not matter (canonical form)
    const reordered = Object.fromEntries(Object.entries(rest).reverse());
    expect(computeEventHash(reordered as typeof rest)).toBe(hash);
  });

  it("[SPEC-13.4] a valid chain verifies with contiguous sequences and prevHash links", () => {
    const events = chainOf(5);
    expect(events[0]!.prevHash).toBeNull();
    for (let i = 1; i < events.length; i++) expect(events[i]!.prevHash).toBe(events[i - 1]!.hash);
    const r = verifyChain(events, start);
    expect(r.findings).toEqual([]);
    expect(r.lastSequence).toBe(5);
  });

  it("[SPEC-13.4] property: modifying any field of any event is detected", () => {
    const events = chainOf(6);
    const mutableFields = ["outcome", "action", "reasonCode", "actorRef", "occurredAt", "tenantId", "idempotencyKey"] as const;
    const replacement: Record<(typeof mutableFields)[number], unknown> = {
      outcome: "FAILED",
      action: "action.commit.failed",
      reasonCode: "TAMPERED_CODE",
      actorRef: "act_synthAttackerActor01",
      occurredAt: "2026-10-17T14:00:00.000Z",
      tenantId: "tnt_synthTenantOther0001",
      idempotencyKey: "idem_synthReplacedKey01",
    };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), fc.constantFrom(...mutableFields), fc.boolean(), (idx, field, rehash) => {
        const copy = events.map((e) => ({ ...e }));
        const target = copy[idx]!;
        (target as Record<string, unknown>)[field] = replacement[field];
        // An attacker may also recompute the tampered event's own hash; the next link still breaks.
        if (rehash) target.hash = computeEventHash(target);
        const r = verifyChain(copy, start);
        if (rehash && idx === 5) {
          // Known limit of a bare chain: a re-hashed FINAL event has no successor link to break.
          // It is detected against the chain head and the shipped copy (verifier.test.ts).
          expect(r.findings).toEqual([]);
          expect(r.lastHash).not.toBe(events[5]!.hash);
          return;
        }
        expect(r.findings.length).toBeGreaterThan(0);
        if (!rehash) expect(r.findings.some((f) => f.code === "HASH_MISMATCH" && f.sequence === idx + 1)).toBe(true);
        else expect(r.findings.some((f) => f.code === "PREV_HASH_MISMATCH" && f.sequence === idx + 2)).toBe(true);
      }),
      { numRuns: 120 },
    );
  });

  it("[SPEC-13.4] property: deleting any non-final event is reported as a sequence gap", () => {
    const events = chainOf(8);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 6 }), (idx) => {
        const copy = events.filter((_, i) => i !== idx);
        const r = verifyChain(copy, start);
        expect(r.findings).toContainEqual(expect.objectContaining({ code: "SEQUENCE_GAP", expectedSequence: idx + 1, sequence: idx + 2 }));
      }),
    );
  });

  it("[SPEC-13.4] reordered or duplicated events are detected", () => {
    const events = chainOf(4);
    const swapped = [events[0]!, events[2]!, events[1]!, events[3]!];
    expect(verifyChain(swapped, start).findings.map((f) => f.code)).toEqual(expect.arrayContaining(["SEQUENCE_GAP", "SEQUENCE_OUT_OF_ORDER"]));
    const dup = [events[0]!, events[1]!, events[1]!, events[2]!];
    expect(verifyChain(dup, start).findings.map((f) => f.code)).toContain("SEQUENCE_OUT_OF_ORDER");
  });

  it("[SPEC-13.4] verification can start from a watermark (purged prefix or previous manifest)", () => {
    const events = chainOf(6);
    const tail = events.slice(3);
    expect(verifyChain(tail, { sourceStream: STREAM, expectedSequence: 4, expectedPrevHash: events[2]!.hash }).findings).toEqual([]);
    expect(verifyChain(tail, { sourceStream: STREAM, expectedSequence: 4, expectedPrevHash: events[1]!.hash }).findings[0]?.code).toBe("PREV_HASH_MISMATCH");
    expect(verifyChain(tail, { sourceStream: "other.stream", expectedSequence: 4, expectedPrevHash: events[2]!.hash }).findings[0]?.code).toBe("STREAM_MISMATCH");
  });

  it("[SPEC-13.4] manifests are deterministic and describe the NDJSON batch exactly", () => {
    const events = chainOf(3);
    const a = buildManifest(events, { manifestId: "amf_synthManifest000001", createdAt: "2026-10-17T15:01:00.000Z" });
    const b = buildManifest(events, { manifestId: "amf_synthManifest000001", createdAt: "2026-10-17T15:01:00.000Z" });
    expect(a).toEqual(b);
    expect(a.manifest).toMatchObject({
      sourceStream: STREAM,
      firstSequence: 1,
      lastSequence: 3,
      eventCount: 3,
      firstPrevHash: null,
      lastHash: events[2]!.hash,
      batchDigest: batchDigestOf(a.ndjson),
      objectKey: `${STREAM}/000000000001-000000000003.ndjson`,
    });
    expect(a.ndjson.split("\n")).toHaveLength(4);
    expect(parseNdjson(a.ndjson).every((l) => l.ok)).toBe(true);
    expect(toNdjson(events)).toBe(a.ndjson);
  });

  it("[SPEC-13.4] NDJSON parsing rejects non-canonical or schema-invalid lines without exposing content", () => {
    const [e] = chainOf(1);
    const nonCanonical = `${JSON.stringify(e, null, 1).replace(/\n/g, "")}\n`;
    expect(parseNdjson(nonCanonical)).toEqual([{ ok: false, lineNumber: 1 }]);
    const extraField = `${canonicalJson({ ...e!, transcript: "x" })}\n`;
    expect(parseNdjson(extraField)).toEqual([{ ok: false, lineNumber: 1 }]);
    expect(parseNdjson("not json\n")).toEqual([{ ok: false, lineNumber: 1 }]);
  });

  it("[SPEC-13.4] object keys round-trip and reject traversal", () => {
    expect(parseObjectKey(objectKeyFor(STREAM, 7, 19))).toEqual({ stream: STREAM, firstSequence: 7, lastSequence: 19 });
    expect(parseObjectKey("../etc/000000000001-000000000002.ndjson")).toBeNull();
    expect(parseObjectKey("a..b/000000000001-000000000002.ndjson")).toBeNull();
  });
});
