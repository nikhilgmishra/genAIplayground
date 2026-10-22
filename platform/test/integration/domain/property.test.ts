/**
 * Layer 2 (WP-23; FO-00-13, ACT-02, ACT-03): a property test of prepare, confirm, commit and reconcile through the
 * PRODUCTION action executor (LedgerActionService on postgres:16) and the domain commit port over the real
 * connector runtime and TLS transport, against the reference business API (fast-check, fixed seed).
 *
 * Each generated case prepares a fresh action (a booking prepared by the domain port or by the business layer without
 * a slot version, a reschedule or a billing review), confirms it, arms
 * one fault at the system of record (none, a held response after commit, a dropped response after commit, a
 * partial write, one 503 before processing, the system unavailable throughout, the slot changed by another
 * channel, the write's COMMIT held after its final deadline check: STALL_BEFORE_COMMIT, so redeliveries and
 * reconciliations run while the first delivery is still inside its transaction), commits, then redelivers it zero
 * to two times, either through the
 * executor (which reconciles an in-doubt action by key before anything else) or directly to the port with the
 * ledger's key (a second replica, a retried message: after the visibility window, or at once), and finally
 * reconciles. Cases run on an account whose lookup answers at once, or on one whose lookup LAGS (`lagged`: a
 * redelivery at once cannot see the first delivery and must still never be FAILED nor duplicate it). Always-run
 * examples with a SHORT preparation (`shortTtl`) reconcile after the write's dispatch deadline while its COMMIT is
 * still held: the decision then comes from the system's fence, never from the time that passed. The
 * properties, read from the
 * system's append-only effect log and the ledger:
 *   - at most one effect per action, whatever the interleaving;
 *   - the ledger ends COMMITTED exactly when the effect exists, with the system's own receipt;
 *   - a direct redelivery (only while the ledger has not settled the action as FAILED: a second key holder) is
 *     never a definite FAILED while the effect exists, and never COMMITTED without it.
 * SYNTHETIC data only.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { PrepareInput } from "../../../src/actions/ports.js";
import { actingPartyFor } from "../../../src/domain/authority.js";
import { requestIdFor } from "../../../src/domain/changes.js";
import type { DomainCommitPort } from "../../../src/domain/commit.js";
import { systemClock } from "../../../src/shared/clock.js";
import { createIntegrationDb } from "../_harness/clients.js";
import type { IntegrationDb } from "../_harness/clients.js";
import { layer2, layer2Context } from "../_harness/layer2.js";
import { ledgerReplica } from "../substrate/reference-sor.js";
import type { LedgerReplica } from "../substrate/reference-sor.js";
import { DOMAIN_SERVICES, allowDecision, createDomainPki, dtmfConfirmation, provisionTenant, seedWorld, sessionOf, sleep } from "./support.js";
import type { DomainPki, Tenant } from "./support.js";

const it = layer2(DOMAIN_SERVICES);

const WRITE_TIMEOUT_MS = 800;
const VISIBILITY_WINDOW_MS = 300;
/** The lagging account: its lookup sees a change only this long after it was applied (within its window). */
const LAG_MS = 400;
const LAGGED_WINDOW_MS = 600;
/** A held COMMIT outlasts the write timeout (the first commit is in doubt); in the short-TTL examples it outlasts the
 * dispatch deadline plus the skew allowance as well (the reconciliation after the deadline runs while it is held). */
const STALL_MS = WRITE_TIMEOUT_MS + 400;
const SHORT_TTL_SECONDS = 5;
const SHORT_TTL_STALL_MS = 2_500;
const SKEW_MS = 100;
const SEED = 2310;
const RUNS = 28;

let pki: DomainPki;
let t0: Tenant;
let tl: Tenant;
let idb: IntegrationDb;
let ledger: LedgerReplica;
let port0: DomainCommitPort;
let portL: DomainCommitPort;

beforeAll(async () => {
  const l2 = layer2Context(DOMAIN_SERVICES);
  pki = createDomainPki();
  t0 = await provisionTenant(l2, pki, { systems: ["scheduling", "billing"], writeTimeoutMs: WRITE_TIMEOUT_MS, visibilityWindowMs: VISIBILITY_WINDOW_MS, clockSkewAllowanceMs: SKEW_MS });
  tl = await provisionTenant(l2, pki, { systems: ["scheduling", "billing"], writeTimeoutMs: WRITE_TIMEOUT_MS, visibilityWindowMs: LAGGED_WINDOW_MS, lookupLagMs: LAG_MS, clockSkewAllowanceMs: SKEW_MS });
  idb = await createIntegrationDb(l2);
  // Short preparations are allowed (the short-TTL examples); generated cases prepare with the usual 300 s.
  ledger = ledgerReplica(idb.db, systemClock, "domain-property", { minPrepareTtlSeconds: SHORT_TTL_SECONDS });
  if (!t0.adapters.commitPort || !tl.adapters.commitPort) throw new Error("commit port composed");
  port0 = t0.adapters.commitPort;
  portL = tl.adapters.commitPort;
}, 180_000);

afterAll(async () => {
  await t0?.dispose();
  await tl?.dispose();
  await idb?.drop();
  pki?.dispose();
});

/** `create_business`: a business-layer preparation of a booking (no slot version: the port looks the key up first). */
const OPERATION = { create: "scheduling.booking.put", create_business: "scheduling.booking.put", reschedule: "scheduling.reschedule.put", review: "billing.review_request.put" } as const;
type Kind = keyof typeof OPERATION;
/** PORT: a direct redelivery after the visibility window; PORT_EARLY: at once (inside a lagging lookup's lag). */
type Via = "EXECUTOR" | "PORT" | "PORT_EARLY";
interface Case {
  kind: Kind;
  fault: Fault;
  redeliveries: Via[];
  lagged: boolean;
  /** A short preparation (examples only): the reconciliation runs after the dispatch deadline, the COMMIT still held. */
  shortTtl: boolean;
}
type Fault = "NONE" | "COMMIT_THEN_DELAY" | "DROP_RESPONSE_AFTER_COMMIT" | "PARTIAL_WRITE" | "HTTP_STATUS" | "UNAVAILABLE" | "STATE_CHANGED" | "STALL_BEFORE_COMMIT";
const FAULTS: readonly Fault[] = ["NONE", "COMMIT_THEN_DELAY", "DROP_RESPONSE_AFTER_COMMIT", "PARTIAL_WRITE", "HTTP_STATUS", "UNAVAILABLE", "STATE_CHANGED", "STALL_BEFORE_COMMIT"];

const settle = <T>(p: Promise<T>): Promise<{ ok: T } | { err: { outcome?: string; reasonCode?: string } }> =>
  p.then(
    (ok) => ({ ok }),
    (e: unknown) => ({ err: e as { outcome?: string; reasonCode?: string } }),
  );

describe("prepare / confirm / commit / reconcile under interleaved faults and redelivery (Layer 2, property)", () => {
  it(
    `[FO-00-13][ACT-02][ACT-03] at most one effect per action and the ledger COMMITTED exactly when the effect exists (fast-check seed ${SEED}, ${RUNS} runs)`,
    async () => {
      const seen: string[] = [];
      const states: string[] = [];
      let portDeliveries = 0;
      await fc.assert(
        fc.asyncProperty(
          fc
            .record<Case>({
              kind: fc.constantFrom<Kind>("create", "create_business", "reschedule", "review"),
              fault: fc.constantFrom<Fault>(...FAULTS),
              redeliveries: fc.array(fc.constantFrom<Via>("EXECUTOR", "PORT", "PORT_EARLY"), { minLength: 0, maxLength: 2 }),
              lagged: fc.boolean(),
              shortTtl: fc.constant(false),
            })
            // Another channel changing the record applies to the slot-versioned actions (the invoice has no such seam).
            .filter((c) => !(c.kind === "review" && c.fault === "STATE_CHANGED")),
          async (c) => {
            seen.push(`${c.kind}/${c.fault}/${c.redeliveries.join("+") || "-"}${c.shortTtl ? "/short" : ""}${c.lagged ? "/lagged" : ""}`);
            const ttlSeconds = c.shortTtl ? SHORT_TTL_SECONDS : 300;
            const t = c.lagged ? tl : t0;
            const port = c.lagged ? portL : port0;
            const window = c.lagged ? LAGGED_WINDOW_MS : VISIBILITY_WINDOW_MS;
            const w = await seedWorld(t);
            const ctx = sessionOf(t.tenantId, w.client, "client");
            const party = actingPartyFor(ctx);
            let input: PrepareInput;
            if (c.kind === "create_business") {
              const slot = await t.adapters.scheduling?.slot(w.slots[0] as string);
              if (!slot) throw new Error("slot");
              input = {
                kind: "appointment.create",
                target: { system: "scheduling", recordType: "appointment_slot", recordRef: slot.slotId, beforeVersion: "slot.open" },
                change: { slotId: slot.slotId, toStartsAt: slot.startsAt, toTimeZone: slot.timeZone, toModality: slot.modality, providerName: slot.providerDisplayName },
                impact: { summaryTemplateId: "appointment.create_confirmation", fees: null, reversible: true },
                confirmationTemplateId: "appointment.create_confirmation",
                ttlSeconds,
                requiresStepUp: false,
              } as PrepareInput;
            } else {
              const prep =
                c.kind === "create"
                  ? await port.prepare(party, { kind: "appointment.create", slotId: w.slots[0] as string })
                  : c.kind === "reschedule"
                    ? await port.prepare(party, { kind: "appointment.reschedule", appointmentId: w.appointment, slotId: w.slots[1] as string })
                    : await port.prepare(party, { kind: "billing.review.submit", invoiceId: w.invoice, reasonCode: "AMOUNT_QUESTIONED" });
              if (prep.ledgerKind === null) throw new Error("ledger kind");
              input = { ...prep.input, kind: prep.ledgerKind, ttlSeconds } as PrepareInput;
            }
            const prepared = await ledger.service.prepare(ctx, input, allowDecision());
            const { confirmation, integration } = dtmfConfirmation(ctx, prepared);
            const action = await ledger.service.confirm(confirmation, integration);
            const key = (await ledger.service.describe?.(t.tenantId, action.actionId))?.providerIdempotencyKey ?? "";
            const effects = async () => (await t.admin.effects(t.accountId)).filter((e) => e.requestId === requestIdFor(key)).length;
            const operation = OPERATION[c.kind];
            // A short preparation is committed close to its expiry, so its dispatch deadline comes within the test.
            if (c.shortTtl) await sleep(Math.max(0, Date.parse(action.expiresAt) - Date.now() - 400));
            const stallMs = c.shortTtl ? SHORT_TTL_STALL_MS : STALL_MS;
            if (c.fault === "STALL_BEFORE_COMMIT") await t.admin.arm(t.accountId, { operation, kind: c.fault, delayMs: stallMs, times: 1 });
            const stallEndsAt = Date.now() + stallMs;
            if (c.fault === "COMMIT_THEN_DELAY") await t.admin.arm(t.accountId, { operation, kind: c.fault, delayMs: WRITE_TIMEOUT_MS + 400, times: 1 });
            if (c.fault === "DROP_RESPONSE_AFTER_COMMIT" || c.fault === "PARTIAL_WRITE") await t.admin.arm(t.accountId, { operation, kind: c.fault, times: 1 });
            if (c.fault === "HTTP_STATUS") await t.admin.arm(t.accountId, { operation, kind: c.fault, status: 503, retryAfterSeconds: 0, times: 1 });
            // The system stays unavailable for the whole first commit (every retry answered 503 before processing).
            if (c.fault === "UNAVAILABLE") await t.admin.arm(t.accountId, { operation, kind: "HTTP_STATUS", status: 503, retryAfterSeconds: 0, times: null });
            // Another channel changed the slot after confirmation: the system refuses the stale version (REJECTED).
            if (c.fault === "STATE_CHANGED") await t.admin.touchSlot(t.accountId, (c.kind === "reschedule" ? w.slots[1] : w.slots[0]) as string);
            const commit = () => ledger.service.commit(ctx, { actionId: action.actionId, digest: action.digest }, { reauthorize: async () => allowDecision(), provider: port });

            await settle(commit());
            const afterFirst = (await ledger.service.describe?.(t.tenantId, action.actionId))?.state;
            expect(await effects()).toBeLessThanOrEqual(1);
            if (c.shortTtl) {
              // Past the dispatch deadline (expiry + write timeout) + skew, while the COMMIT may still be held: the
              // executor reconciles. Only the system's fence can settle it; a held COMMIT must never become NOT_FOUND.
              await sleep(Math.max(0, Date.parse(action.expiresAt) + WRITE_TIMEOUT_MS + SKEW_MS + 50 - Date.now()));
              const early = await settle(ledger.service.reconcileWithResult?.(t.tenantId, action.actionId, port) ?? Promise.resolve(undefined));
              const earlyResult = "ok" in early ? early.ok?.result : `threw:${early.err.reasonCode}`;
              seen.push(`short-reconcile:${c.fault}:${earlyResult}`);
              if (c.fault === "STALL_BEFORE_COMMIT") expect(earlyResult, "a reconciliation while the COMMIT is held").not.toBe("NOT_FOUND");
            }
            await t.admin.clearFaults(t.accountId);
            // A held response is still in flight at the system: let it finish before redelivering.
            if (c.fault === "COMMIT_THEN_DELAY") await sleep(500);
            for (const via of c.redeliveries) {
              if (via === "EXECUTOR") {
                await settle(commit());
              } else {
                // A second holder of the same key (a replica that claimed the commit slot, a retried message) exists
                // only while the ledger has not settled the action as definitely failed: model exactly that.
                const before = (await ledger.service.describe?.(t.tenantId, action.actionId))?.state;
                if (before !== "COMMITTING" && before !== "UNKNOWN" && before !== "COMMITTED") {
                  seen.push(`port-skipped:${before}`);
                  continue;
                }
                portDeliveries += 1;
                // PORT: a later redelivery, past the visibility window (an earlier delivery is visible to a lookup);
                // PORT_EARLY: at once, inside a lagging lookup's lag (it cannot see the earlier delivery).
                if (via === "PORT") await sleep(window + 100);
                const r = await settle(port.commit(action, key));
                const outcome = "ok" in r ? r.ok.outcome : r.err.outcome;
                if (await effects() === 1) expect(outcome, `a redelivery after ${before} is never a definite FAILED while the effect exists`).not.toBe("FAILED");
                if ("ok" in r && r.ok.outcome === "COMMITTED") expect(await effects()).toBe(1);
              }
              expect(await effects()).toBeLessThanOrEqual(1);
            }
            // A held COMMIT lands before the final reconciliation (the in-flight delivery is part of the history).
            if (c.fault === "STALL_BEFORE_COMMIT") await sleep(Math.max(0, stallEndsAt - Date.now() + 300));
            // Final reconciliation: the executor resolves any in-doubt action by key; a confirmed one commits.
            // (On the lagging account only once its window has passed: inside it a lookup cannot see the change.)
            if (c.lagged) await sleep(window + 100);
            const state = (await ledger.service.describe?.(t.tenantId, action.actionId))?.state;
            if (state === "UNKNOWN" || state === "COMMITTING") await settle(ledger.service.reconcile(action.actionId, port, t.tenantId));
            if ((await ledger.service.describe?.(t.tenantId, action.actionId))?.state === "CONFIRMED") await settle(commit());
            const final = await ledger.service.describe?.(t.tenantId, action.actionId);
            const n = await effects();
            states.push(`${c.fault}:${afterFirst}->${final?.state}:${n}`);
            expect(n).toBeLessThanOrEqual(1);
            expect(final?.state === "COMMITTED", `ledger ${final?.state} with ${n} effect(s)`).toBe(n === 1);
            if (final?.state === "COMMITTED") {
              const stored = await t.admin.changeRequest(t.accountId, requestIdFor(key));
              expect(stored?.state).toBe("COMPLETED");
              expect(final.receipt?.providerReference).toBe(stored?.receipt_id);
            }
          },
        ),
        {
          seed: SEED,
          numRuns: RUNS,
          endOnFailure: true,
          // Always-run cases on top of the generated ones: the interleavings whose wrong answer would be a duplicate
          // effect or a false FAILED (an INCOMPLETE write found by a lookup-first redelivery, a held response
          // redelivered, a refusal for a changed record, an outage that must stay retryable).
          examples: [
            [{ kind: "create_business", fault: "PARTIAL_WRITE", redeliveries: ["PORT"], lagged: false, shortTtl: false }],
            [{ kind: "create_business", fault: "DROP_RESPONSE_AFTER_COMMIT", redeliveries: ["PORT", "EXECUTOR"], lagged: false, shortTtl: false }],
            [{ kind: "create", fault: "COMMIT_THEN_DELAY", redeliveries: ["PORT"], lagged: false, shortTtl: false }],
            [{ kind: "reschedule", fault: "PARTIAL_WRITE", redeliveries: ["PORT", "EXECUTOR"], lagged: false, shortTtl: false }],
            [{ kind: "create", fault: "STATE_CHANGED", redeliveries: ["EXECUTOR"], lagged: false, shortTtl: false }],
            [{ kind: "review", fault: "UNAVAILABLE", redeliveries: [], lagged: false, shortTtl: false }],
            // Billing: a timeout after the review request was sent (held response), and a lost response followed by a
            // duplicate delivery of the same request.
            [{ kind: "review", fault: "COMMIT_THEN_DELAY", redeliveries: ["EXECUTOR"], lagged: false, shortTtl: false }],
            [{ kind: "review", fault: "DROP_RESPONSE_AFTER_COMMIT", redeliveries: ["PORT"], lagged: false, shortTtl: false }],
            // A lagging lookup: a business-prepared booking redelivered at once after it committed (the slot reads
            // taken, the key not yet visible: never FAILED, never a second booking), a lost response redelivered at
            // once, and a reschedule redelivered at once.
            [{ kind: "create_business", fault: "NONE", redeliveries: ["PORT_EARLY", "EXECUTOR"], lagged: true, shortTtl: false }],
            [{ kind: "create_business", fault: "DROP_RESPONSE_AFTER_COMMIT", redeliveries: ["PORT_EARLY"], lagged: true, shortTtl: false }],
            [{ kind: "reschedule", fault: "NONE", redeliveries: ["PORT_EARLY"], lagged: true, shortTtl: false }],
            // Commit latency: the first delivery's COMMIT held after its final deadline check. A redelivery while it is
            // held waits on the request id and replays it (never a second effect, never FAILED); a business-prepared
            // one redelivered at once on the lagging account; and, with a short preparation, the executor's
            // reconciliation after the dispatch deadline while the COMMIT is still held (only the fence decides:
            // never NOT_FOUND / EXPIRED), then COMMITTED once it lands.
            [{ kind: "create", fault: "STALL_BEFORE_COMMIT", redeliveries: ["PORT"], lagged: false, shortTtl: false }],
            [{ kind: "create_business", fault: "STALL_BEFORE_COMMIT", redeliveries: ["PORT_EARLY", "EXECUTOR"], lagged: true, shortTtl: false }],
            [{ kind: "create", fault: "STALL_BEFORE_COMMIT", redeliveries: [], lagged: false, shortTtl: true }],
            [{ kind: "review", fault: "STALL_BEFORE_COMMIT", redeliveries: [], lagged: false, shortTtl: true }],
          ],
        },
      );
      // The generated cases cover every fault, both redelivery routes and the lagging account (no vacuous run).
      for (const f of FAULTS) expect(seen.some((s) => s.includes(`/${f}/`)), f).toBe(true);
      expect(seen.some((s) => s.includes("PORT_EARLY") && s.endsWith("/lagged"))).toBe(true);
      // The short-TTL examples reached a reconciliation after the deadline while the COMMIT was held (never NOT_FOUND).
      expect(seen.filter((s) => s.startsWith("short-reconcile:STALL_BEFORE_COMMIT:")).length, seen.join(" ")).toBe(2);
      expect(portDeliveries, "direct redeliveries to the port were made, not only skipped").toBeGreaterThan(0);
      expect(seen.some((s) => s.includes("EXECUTOR"))).toBe(true);
      // And the faults bite: some first commits were left in doubt and were then resolved to exactly one effect.
      expect(states.some((s) => /:(UNKNOWN|COMMITTING)->COMMITTED:1$/.test(s)), states.join(" ")).toBe(true);
      expect(states.some((s) => /^NONE:COMMITTED->COMMITTED:1$/.test(s)), states.join(" ")).toBe(true);
      // And the other direction: a write refused for a changed record ends settled without an effect (the executor
      // records the changed state as INVALIDATED), never COMMITTED; an unavailable system leaves it retryable.
      expect(states.some((s) => /^STATE_CHANGED:(FAILED|INVALIDATED)->(FAILED|INVALIDATED):0$/.test(s)), states.join(" ")).toBe(true);
      expect(states.some((s) => /^UNAVAILABLE:CONFIRMED->COMMITTED:1$/.test(s)), states.join(" ")).toBe(true);
    },
    360_000,
  );
});
