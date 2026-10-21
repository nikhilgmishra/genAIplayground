/**
 * Keyed digests of the connector change feed (WP-07; DATA-01, DP-02 pattern): the content-free index rows and
 * dead-letter envelopes never carry a plain SHA-256 of a low-entropy record key. Docker-free; the Layer-2 run over
 * ElasticMQ and PostgreSQL is composition/faults.test.ts ([FAULT:DLQ_FULL]). SYNTHETIC values only.
 */
import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MappedRecord } from "../../connectors/dsl/mapping.js";
import type { Queryable } from "../../db/types.js";
import { FakeClock } from "../../shared/clock.js";
import { CONNECTOR_FEED_DEAD_LETTER_SCHEMA, ConnectorFeedSync, FeedDigester } from "./connector-feed.js";

const SCOPE = { tenantId: "tnt_synthFeedDigest0001", profileId: "cnp_synthFeedDigest01", streamId: "appointments" };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const record = (values: Record<string, unknown>): MappedRecord => ({ values }) as unknown as MappedRecord;

/**
 * Independent reference of the documented construction (not FeedDigester): HMAC-SHA256 under the HKDF-SHA256
 * subkey of the pepper (salt "vsp.connector-feed", info "vsp.connector-feed.digest.v1"), over NUL-joined fields.
 */
const referenceKey = (pepper: Uint8Array) => Buffer.from(hkdfSync("sha256", pepper, Buffer.from("vsp.connector-feed", "utf8"), Buffer.from("vsp.connector-feed.digest.v1", "utf8"), 32));
const referenceMac = (pepper: Uint8Array, parts: readonly string[]) => createHmac("sha256", referenceKey(pepper)).update(parts.join("\u0000"), "utf8").digest("hex");

/** TEST-ONLY recording Queryable (captures the index writes of one page). */
function recordingTx(): { tx: Queryable; params: unknown[][] } {
  const params: unknown[][] = [];
  const tx = { query: async (_sql: string, p: unknown[] = []) => (params.push(p), { rows: [], rowCount: 1 }) } as unknown as Queryable;
  return { tx, params };
}

describe("FeedDigester [DATA-01]", () => {
  it("[DATA-01] record-key digests are HMAC-SHA256 under the environment key: never the plain SHA-256, stable for one key, different for another key or another feed", () => {
    const pepper = randomBytes(32);
    const d = FeedDigester.fromPepper(pepper);
    const key = "apt-00003";
    const digest = d.recordKey(SCOPE, key);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe(sha256(key));
    expect(digest).toBe(FeedDigester.fromPepper(pepper).recordKey(SCOPE, key));
    expect(digest).not.toBe(FeedDigester.fromPepper(randomBytes(32)).recordKey(SCOPE, key));
    expect(digest).not.toBe(d.recordKey({ ...SCOPE, streamId: "claims" }, key));
    // The HKDF subkey is not the pepper itself: an HMAC under the raw pepper does not match.
    expect(digest).not.toBe(createHash("sha256").update(pepper).update(key).digest("hex"));
    expect(new FeedDigester(pepper).recordKey(SCOPE, key)).not.toBe(digest);
  });

  it("[DATA-01] the record-key digest is exactly the documented keyed construction (independent reference)", () => {
    const pepper = randomBytes(32);
    const key = "apt-00003";
    expect(FeedDigester.fromPepper(pepper).recordKey(SCOPE, key)).toBe(referenceMac(pepper, ["record-key", SCOPE.tenantId, SCOPE.profileId, SCOPE.streamId, key]));
  });

  it("[DATA-01] the record digest is keyed (it changes with the environment key, so it cannot be recomputed without it) and domain-separated from the record-key digest", () => {
    const pepper = randomBytes(32);
    const d = FeedDigester.fromPepper(pepper);
    const r = record({ appointmentId: "apt-00003", status: "booked" });
    const canonical = JSON.stringify([["appointmentId", "apt-00003"], ["status", "booked"]]);
    const digest = d.record(SCOPE, r);
    // Exactly the keyed construction over the canonical (sorted) values, under the HKDF subkey of THIS pepper.
    expect(digest).toBe(referenceMac(pepper, ["record", SCOPE.tenantId, SCOPE.profileId, SCOPE.streamId, canonical]));
    // Keyed: another environment key gives another digest; no unkeyed hash of the same input matches.
    expect(digest).not.toBe(FeedDigester.fromPepper(randomBytes(32)).record(SCOPE, r));
    expect(digest).toBe(FeedDigester.fromPepper(Buffer.from(pepper)).record(SCOPE, r));
    expect(digest).not.toBe(sha256(canonical));
    expect(digest).not.toBe(sha256(["record", SCOPE.tenantId, SCOPE.profileId, SCOPE.streamId, canonical].join("\u0000")));
    expect(digest).not.toBe(createHmac("sha256", "").update(canonical, "utf8").digest("hex"));
    expect(digest).not.toBe(createHmac("sha256", Buffer.alloc(0)).update(["record", SCOPE.tenantId, SCOPE.profileId, SCOPE.streamId, canonical].join("\u0000"), "utf8").digest("hex"));
    // Stable key order; a different feed or a different value gives a different digest.
    expect(digest).toBe(d.record(SCOPE, record({ status: "booked", appointmentId: "apt-00003" })));
    expect(digest).not.toBe(d.record({ ...SCOPE, streamId: "claims" }, r));
    expect(digest).not.toBe(d.record(SCOPE, record({ appointmentId: "apt-00003", status: "cancelled" })));
    expect(digest).not.toBe(d.recordKey(SCOPE, canonical));
  });

  it("[DATA-01] a key shorter than 32 bytes is refused", () => {
    expect(() => FeedDigester.fromPepper(randomBytes(16))).toThrow("CONNECTOR_FEED_DIGEST_KEY_INVALID");
    expect(() => new FeedDigester(randomBytes(31))).toThrow("CONNECTOR_FEED_DIGEST_KEY_INVALID");
  });
});

describe("ConnectorFeedSync.project keyed digests [DATA-01][OPS-01]", () => {
  it("[DATA-01] index rows and the dead-letter envelope (and its deduplication id) carry the keyed digests only", async () => {
    const d = FeedDigester.fromPepper(randomBytes(32));
    const letters: { body: string; deduplicationId?: string }[] = [];
    const sync = new ConnectorFeedSync({
      reader: { runOnce: async () => ({ completeness: "CAUGHT_UP", pages: 0, records: 0 }) as never, checkpoint: async () => null },
      digester: d,
      deadLetters: { write: async (body, a) => (letters.push({ body, ...(a.deduplicationId ? { deduplicationId: a.deduplicationId } : {}) }), "msg-1") },
      ...SCOPE,
      keyField: "appointmentId",
      updatedAtField: "updatedAt",
      maxPagesPerRun: 1,
      clock: new FakeClock("2026-10-21T12:00:00.000Z"),
    });
    const { tx, params } = recordingTx();
    const keyless = record({ status: "booked" });
    await sync.project(tx, [record({ appointmentId: "apt-00001", updatedAt: "2026-10-20T00:00:00.000Z" }), keyless]);
    expect(params).toHaveLength(1);
    expect(params[0]?.[3]).toBe(d.recordKey(SCOPE, "apt-00001"));
    expect(params[0]?.[3]).not.toBe(sha256("apt-00001"));
    expect(letters).toHaveLength(1);
    const body = JSON.parse(letters[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ schema: CONNECTOR_FEED_DEAD_LETTER_SCHEMA, recordDigest: d.record(SCOPE, keyless), reasonCode: "FEED_RECORD_KEY_MISSING" });
    expect(body.recordDigest).not.toBe(sha256(JSON.stringify([["status", "booked"]])));
    expect(letters[0]?.deduplicationId).toBe(d.record(SCOPE, keyless).slice(0, 64));
    expect(letters[0]?.body).not.toContain("booked");
  });
});
