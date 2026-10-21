/**
 * Credential rotation anchored at the PROMOTION of the current version (FO-06-98, FO-15-50; AUTH-04), over real
 * PostgreSQL SQL (PGlite with migration 2044) and the production SecretsManagerCredentialResolver and
 * PgCredentialPromotionLedger. The Secrets Manager API is a UNIT FAKE (StageTableFake below: GetSecretValue by
 * stage); Layer 2 runs the same resolver against LocalStack Secrets Manager with UpdateSecretVersionStage
 * (test/integration/ingress/http.test.ts).
 */
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "../db/pglite.js";
import { createTestDb } from "../db/testing.js";
import { FakeClock } from "../shared/clock.js";
import { PgCredentialPromotionLedger, SecretsManagerCredentialResolver } from "./credentials.js";
import type { SecretsSender } from "./credentials.js";

const REF = "arn:aws:secretsmanager:us-east-1:123456789012:secret:vsp/ingress/synthetic-AbCdEf";
const POLICY = { overlapSeconds: 3600, acceptPending: false };
const keyJson = (b: number) => JSON.stringify({ key: Buffer.alloc(32, b).toString("base64") });

/** UNIT FAKE of Secrets Manager's stage table (not the service): which version holds which stage. */
class StageTableFake implements SecretsSender {
  readonly label = "UNIT FAKE — Secrets Manager stage table";
  versions = new Map<string, { secret: string; created: Date | null }>();
  stages = new Map<"AWSCURRENT" | "AWSPREVIOUS" | "AWSPENDING", string>();
  calls = 0;
  failing = false;

  put(versionId: string, b: number, created: Date | null): this {
    this.versions.set(versionId, { secret: keyJson(b), created });
    return this;
  }
  stage(stage: "AWSCURRENT" | "AWSPREVIOUS" | "AWSPENDING", versionId: string | null): this {
    if (versionId === null) this.stages.delete(stage);
    else this.stages.set(stage, versionId);
    return this;
  }
  /** UpdateSecretVersionStage(AWSCURRENT -> v): the old current becomes AWSPREVIOUS, v leaves AWSPENDING. */
  promote(versionId: string): this {
    const old = this.stages.get("AWSCURRENT");
    if (old) this.stages.set("AWSPREVIOUS", old);
    this.stages.set("AWSCURRENT", versionId);
    if (this.stages.get("AWSPENDING") === versionId) this.stages.delete("AWSPENDING");
    return this;
  }
  async send(command: GetSecretValueCommand): Promise<unknown> {
    this.calls += 1;
    if (this.failing) throw Object.assign(new Error("unavailable"), { name: "InternalServiceError" });
    const stage = command.input.VersionStage as "AWSCURRENT" | "AWSPREVIOUS" | "AWSPENDING";
    const id = this.stages.get(stage);
    const v = id ? this.versions.get(id) : undefined;
    if (!id || !v) throw Object.assign(new Error("not found"), { name: "ResourceNotFoundException" });
    return { VersionId: id, SecretString: v.secret, ...(v.created ? { CreatedDate: v.created } : {}) };
  }
}

let db: PgliteDb;
let clock: FakeClock;
let sm: StageTableFake;

/** Creating and migrating an embedded PostgreSQL can take long on a contended shared machine. */
const PGLITE_SETUP_TIMEOUT_MS = 120_000;

beforeEach(async () => {
  db = await createTestDb({ include: /^(2041|2044)/ });
  clock = new FakeClock("2026-10-19T10:00:00.000Z");
  sm = new StageTableFake();
}, PGLITE_SETUP_TIMEOUT_MS);
afterEach(async () => {
  await db.close();
});

const resolver = (opts: { maxObservationGapMs?: number } = {}) =>
  new SecretsManagerCredentialResolver({ client: sm, clock, promotions: new PgCredentialPromotionLedger({ db }), cacheTtlMs: 0, ...opts });
const versionsAt = async (r: SecretsManagerCredentialResolver) => (await r.activeVersions(REF, POLICY, clock.now())).map((v) => `${v.version}:${v.stage}`);
const basisOf = async (versionId: string) =>
  (await db.tx((tx) => tx.query<{ basis: string }>("select anchor_basis as basis from ingress_credential_promotions where credential_ref = $1 and version_id = $2", [REF, versionId]), { role: "owner" })).rows[0]?.basis ?? null;

describe("SecretsManagerCredentialResolver: the overlap counts from the promotion", () => {
  it("[FO-06-98][AUTH-04] a next key staged two hours before its promotion: the old key verifies for the full overlap after the (witnessed) promotion, at another replica and after a restart, then never again", async () => {
    sm.put("v1", 1, new Date("2026-10-19T09:00:00.000Z")).stage("AWSCURRENT", "v1");
    const a = resolver();
    expect(await versionsAt(a)).toEqual(["v1:current"]);
    sm.put("v2", 2, clock.now()).stage("AWSPENDING", "v2"); // staged at 10:00
    clock.advanceSeconds(2 * 3600);
    expect(await versionsAt(a)).toEqual(["v1:current"]); // 12:00, v1 still current (observed)
    sm.promote("v2");
    clock.advanceSeconds(20);
    expect(await versionsAt(a)).toEqual(["v2:current", "v1:previous"]);
    expect(await basisOf("v2")).toBe("WITNESSED");
    clock.advanceSeconds(3600 - 1);
    expect(await versionsAt(resolver()), "a fresh resolver (replica or restart) reads the same anchor").toEqual(["v2:current", "v1:previous"]);
    clock.advanceSeconds(2);
    expect(await versionsAt(a)).toEqual(["v2:current"]);
    expect(await versionsAt(resolver())).toEqual(["v2:current"]);
    // Refreshing never re-opens the window.
    for (let i = 0; i < 3; i++) {
      clock.advanceSeconds(60);
      expect(await versionsAt(a)).toEqual(["v2:current"]);
    }
  });

  it("[FO-06-98][AUTH-04] fail closed when the promotion was not witnessed: the overlap counts from the new version's creation (a lower bound), and without a creation time there is none", async () => {
    // Cold start: the platform never saw v1 as current; v2 was created two hours ago and promoted since.
    sm.put("v1", 1, new Date("2026-10-19T07:00:00.000Z")).put("v2", 2, new Date("2026-10-19T08:00:00.000Z")).stage("AWSCURRENT", "v2").stage("AWSPREVIOUS", "v1");
    expect(await versionsAt(resolver())).toEqual(["v2:current"]);
    expect(await basisOf("v2")).toBe("VERSION_CREATED");
    // v3 is created and promoted while nothing observes the secret for three hours (longer than the observation
    // bound): the promotion happened somewhere in that gap, so the overlap counts from the last time v2 was seen
    // as current (a lower bound) and has already ended.
    sm.put("v3", 3, clock.now()).promote("v3");
    clock.advanceSeconds(3 * 3600);
    expect(await versionsAt(resolver({ maxObservationGapMs: 300_000 }))).toEqual(["v3:current"]);
    expect(await basisOf("v3")).toBe("PREVIOUS_LAST_SEEN");
    // No creation time reported and nothing witnessed: the previous version gets no overlap at all.
    const other = "arn:aws:secretsmanager:us-east-1:123456789012:secret:vsp/ingress/no-dates-XyZabc";
    sm = new StageTableFake().put("w1", 1, null).put("w2", 2, null).stage("AWSCURRENT", "w2").stage("AWSPREVIOUS", "w1");
    const blind = resolver();
    expect((await blind.activeVersions(other, POLICY, clock.now())).map((v) => v.version)).toEqual(["w2"]);
    clock.advanceSeconds(10);
    expect((await blind.activeVersions(other, POLICY, clock.now())).map((v) => v.version), "a refresh does not restart a window").toEqual(["w2"]);
    const row = await db.tx((tx) => tx.query<{ basis: string; anchor: unknown }>("select anchor_basis as basis, overlap_anchor_at as anchor from ingress_credential_promotions where credential_ref = $1", [other]), { role: "owner" });
    expect(row.rows).toEqual([{ basis: "UNKNOWN", anchor: null }]);
  });

  it("[FO-06-98][OPS-03] concurrent first observations by two replicas agree on one anchor; the recorded anchor cannot be rewritten", async () => {
    sm.put("v1", 1, new Date("2026-10-19T09:00:00.000Z")).stage("AWSCURRENT", "v1");
    await versionsAt(resolver());
    sm.put("v2", 2, new Date("2026-10-19T09:30:00.000Z")).promote("v2");
    const [x, y] = await Promise.all([versionsAt(resolver()), versionsAt(resolver())]);
    expect(x).toEqual(y);
    const rows = await db.tx((tx) => tx.query("select version_id from ingress_credential_promotions where credential_ref = $1 order by version_id", [REF]), { role: "owner" });
    expect(rows.rows).toEqual([{ version_id: "v1" }, { version_id: "v2" }]);
    const reason = (p: Promise<unknown>) => p.then(() => "RESOLVED", (e: Error) => e.message);
    expect(await reason(db.tx((tx) => tx.query("update ingress_credential_promotions set overlap_anchor_at = now() + interval '1 day' where version_id = 'v2'"), { role: "app_runtime" }))).toContain("permission denied");
    expect(await reason(db.tx((tx) => tx.query("update ingress_credential_promotions set overlap_anchor_at = now() + interval '1 day' where version_id = 'v2'"), { role: "owner" }))).toContain("CREDENTIAL_PROMOTION_IMMUTABLE");
    expect(await reason(db.tx((tx) => tx.query("delete from ingress_credential_promotions"), { role: "owner" }))).toContain("CREDENTIAL_PROMOTION_APPEND_ONLY");
  });

  it("[FO-06-98][OPS-03] an unavailable secret store or promotion ledger fails closed with a reason code; the pending key verifies only for a profile that accepts it", async () => {
    sm.put("v1", 1, new Date("2026-10-19T09:00:00.000Z")).stage("AWSCURRENT", "v1").put("v2", 2, clock.now()).stage("AWSPENDING", "v2");
    const r = resolver();
    expect(await versionsAt(r)).toEqual(["v1:current"]);
    expect((await r.activeVersions(REF, { ...POLICY, acceptPending: true }, clock.now())).map((v) => `${v.version}:${v.stage}`)).toEqual(["v1:current", "v2:pending"]);
    sm.failing = true;
    await expect(r.activeVersions(REF, POLICY, clock.now())).rejects.toMatchObject({ reasonCode: "INGRESS_CREDENTIAL_UNAVAILABLE" });
    sm.failing = false;
    const broken = new SecretsManagerCredentialResolver({ client: sm, clock, promotions: { observeCurrent: () => Promise.reject(new Error("ledger down")) }, cacheTtlMs: 0 });
    await expect(broken.activeVersions(REF, POLICY, clock.now())).rejects.toThrow();
    expect(() => new SecretsManagerCredentialResolver({ client: sm, clock, promotions: new PgCredentialPromotionLedger({ db }), cacheTtlMs: 120_000, maxObservationGapMs: 60_000 })).toThrow("INGRESS_CREDENTIAL_OBSERVATION_GAP_INVALID");
  });
});
