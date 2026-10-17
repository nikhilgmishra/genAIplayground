import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { createTestDb } from "../db/testing.js";
import type { PgliteDb } from "../db/pglite.js";
import { OTHER_TENANT_ID, TENANT_ID } from "../fixtures/synthetic-world.js";
import { FakeClock } from "../shared/clock.js";
import { newSessionRef } from "../shared/ids.js";
import { sessionBindingRef } from "./digest.js";
import { ToolRequestIdempotency, computeToolRequestHash } from "./tool-idempotency.js";

let db: PgliteDb;
let clock: FakeClock;
let svc: ToolRequestIdempotency;
const scope = { tenantId: TENANT_ID, integrationId: "talkdesk-mcp-local" };
const meta = { toolName: "get_appointment_options", toolVersion: "1.0.0" };
const KEY = "idem_synthKey00000000001";

beforeEach(async () => {
  db = await createTestDb({ include: /^01/ });
  clock = new FakeClock();
  svc = new ToolRequestIdempotency({ db, clock, retentionSeconds: 3_600, leaseSeconds: 30 });
});
afterEach(async () => {
  await db.close();
});

const hashOf = (args: Record<string, unknown>, sessionRef = "ses_synthSessionForHash0001") =>
  computeToolRequestHash({ toolName: meta.toolName, toolVersion: meta.toolVersion, arguments: args, sessionBinding: sessionBindingRef(sessionRef) });
const reason = (p: Promise<unknown>) => p.then(() => "RESOLVED", (e: { reasonCode?: string }) => e.reasonCode ?? "NO_REASON_CODE");

describe("ToolRequestIdempotency", () => {
  it("[ACT-02] a repeated tool request with the same key and request returns the stored result without re-execution", async () => {
    const h = hashOf({ appointmentId: "apt_synthAveryAppt00001" });
    expect(await svc.reserve(scope, KEY, h, meta)).toEqual({ status: "NEW" });
    await svc.complete(scope, KEY, h, { status: "SUCCESS", data: { optionCount: 3 } });
    const again = await svc.reserve(scope, KEY, h, meta);
    expect(again).toMatchObject({ status: "REPLAY", response: { status: "SUCCESS", data: { optionCount: 3 } } });
    expect(await svc.lookup(scope, KEY, h)).toMatchObject({ status: "COMPLETED" });
  });

  it("[ACT-02] the same key with a different request hash is rejected (IDEMPOTENCY_KEY_REUSED)", async () => {
    const h1 = hashOf({ appointmentId: "apt_synthAveryAppt00001" });
    const h2 = hashOf({ appointmentId: "apt_synthBlakeAppt00001" });
    await svc.reserve(scope, KEY, h1, meta);
    expect(await reason(svc.reserve(scope, KEY, h2, meta))).toBe("IDEMPOTENCY_KEY_REUSED");
    await svc.complete(scope, KEY, h1, { status: "SUCCESS" });
    expect(await reason(svc.reserve(scope, KEY, h2, meta))).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await reason(svc.lookup(scope, KEY, h2))).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await reason(svc.record(scope, KEY, h2, meta, { status: "SUCCESS" }))).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("[ACT-02] the request hash binds the session: the same key and arguments from another session is a mismatch", () => {
    const args = { appointmentId: "apt_synthAveryAppt00001" };
    expect(hashOf(args, newSessionRef())).not.toBe(hashOf(args, newSessionRef()));
    expect(hashOf({ b: 1, a: 2 })).toBe(hashOf({ a: 2, b: 1 }));
  });

  it("[SPEC-12.3] a concurrent duplicate while the first execution is in flight gets IN_PROGRESS, not a second execution", async () => {
    const h = hashOf({ x: 1 });
    expect((await svc.reserve(scope, KEY, h, meta)).status).toBe("NEW");
    expect((await svc.reserve(scope, KEY, h, meta)).status).toBe("IN_PROGRESS");
    // A crashed in-flight reservation can be re-taken after its lease.
    clock.advanceSeconds(31);
    expect((await svc.reserve(scope, KEY, h, meta)).status).toBe("NEW");
  });

  it("[SPEC-12.3] a released reservation (retryable failure) can execute again with the same key", async () => {
    const h = hashOf({ x: 1 });
    await svc.reserve(scope, KEY, h, meta);
    await svc.release(scope, KEY, h);
    expect(await svc.lookup(scope, KEY, h)).toEqual({ status: "RELEASED" });
    expect((await svc.reserve(scope, KEY, h, meta)).status).toBe("NEW");
  });

  it("[AUTH-04] expired records are ignored by readers before any purge and the key may be re-bound", async () => {
    const h1 = hashOf({ x: 1 });
    await svc.record(scope, KEY, h1, meta, { status: "SUCCESS" });
    clock.advanceSeconds(3_601);
    expect(await svc.lookup(scope, KEY, h1)).toBeNull();
    const h2 = hashOf({ x: 2 });
    expect((await svc.reserve(scope, KEY, h2, meta)).status).toBe("NEW");
    clock.advanceSeconds(3_601);
    expect(await svc.purgeExpired(TENANT_ID)).toBe(1);
  });

  it("[AUTH-05] idempotency records are tenant and integration scoped", async () => {
    const h = hashOf({ x: 1 });
    await svc.record(scope, KEY, h, meta, { status: "SUCCESS" });
    expect(await svc.lookup({ ...scope, tenantId: OTHER_TENANT_ID }, KEY, h)).toBeNull();
    expect(await svc.lookup({ ...scope, integrationId: "portal-local" }, KEY, h)).toBeNull();
    expect((await svc.reserve({ ...scope, tenantId: OTHER_TENANT_ID }, KEY, hashOf({ y: 1 }), meta)).status).toBe("NEW");
  });

  it("[SPEC-8.1] completion inside the caller's transaction rolls back with it", async () => {
    const h = hashOf({ x: 1 });
    await svc.reserve(scope, KEY, h, meta);
    await expect(
      db.tx(
        async (tx) => {
          await svc.completeInTx(tx, scope, KEY, h, { status: "SUCCESS" });
          throw new Error("effect failed");
        },
        { role: "app_runtime", rls: { tenantId: TENANT_ID } },
      ),
    ).rejects.toThrow("effect failed");
    expect(await svc.lookup(scope, KEY, h)).toEqual({ status: "IN_PROGRESS" });
  });

  it("[SPEC-8.1] strict validation of keys, hashes and bounded responses", async () => {
    const h = hashOf({ x: 1 });
    expect(await reason(svc.reserve(scope, "short", h, meta))).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(await reason(svc.reserve(scope, KEY, "nothex", meta))).toBe("IDEMPOTENCY_REQUEST_HASH_INVALID");
    expect(await reason(svc.reserve({ ...scope, integrationId: "Bad Id" }, KEY, h, meta))).toBe("IDEMPOTENCY_SCOPE_INVALID");
    await svc.reserve(scope, KEY, h, meta);
    expect(await reason(svc.complete(scope, KEY, h, { blob: "x".repeat(70_000) }))).toBe("IDEMPOTENCY_RESPONSE_INVALID");
  });

  let propertyRun = 0;
  it("[ACT-02] property: for any sequence of requests on one key, the first request's result is the only one ever replayed", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 8 }), async (seq) => {
        propertyRun += 1;
        const key = `idem_property_run_${String(propertyRun).padStart(6, "0")}`;
        let firstHash: string | null = null;
        let stored: Record<string, unknown> | null = null;
        for (const n of seq) {
          const h = hashOf({ n });
          firstHash ??= h;
          const r = await svc.record(scope, key, h, meta, { n }).then(
            (x) => x,
            (e: { reasonCode: string }) => e.reasonCode,
          );
          if (h === firstHash) {
            expect(typeof r).toBe("object");
            if (typeof r === "object") {
              stored ??= r.response;
              expect(r.response).toEqual(stored);
            }
          } else {
            expect(r).toBe("IDEMPOTENCY_KEY_REUSED");
          }
        }
      }),
      { seed: 21, numRuns: 25 },
    );
  });
});
