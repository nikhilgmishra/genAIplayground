/**
 * OPS-AUD-01: the `audit` label of vsp_protected_actions_total is derived from the gateway's actual
 * tool.invoke audit append (the result's auditEventId), never hard-coded. An accepted consequential
 * action whose tool.invoke event could not be appended is counted audit="not_recorded", so the
 * audited_accepted_actions SLO and the "Protected actions without decision or audit" dashboard panel
 * can fall below 100%. Real policy bundle, PGlite, PgAuditWriter; LOCAL FIXTURE tools; SYNTHETIC data.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEventInput } from "../protocol/index.js";
import { AuditUnavailableError } from "../shared/errors.js";
import { createGatewayHarness } from "./fixtures/harness.fixture.js";
import type { GatewayHarness } from "./fixtures/harness.fixture.js";

let h: GatewayHarness;
afterEach(async () => {
  await h?.close();
});

const header = (sessionRef: string) => ({ sessionRefHeader: sessionRef });
const commitArgs = { actionId: "act_synthFixtureAction01", digest: "a".repeat(64) };

/** Fails only the gateway's tool.invoke appends (LOCAL TEST FIXTURE outage of that one event). */
function failToolInvokeAppends(harness: GatewayHarness): { restore: () => void; failed: () => number } {
  const realAppend = harness.audit.appendStandalone.bind(harness.audit);
  let failed = 0;
  harness.audit.appendStandalone = async (input: AuditEventInput, stream?: string) => {
    if (input.action === "tool.invoke") {
      failed += 1;
      throw new AuditUnavailableError();
    }
    return realAppend(input, stream);
  };
  return {
    restore: () => {
      harness.audit.appendStandalone = realAppend;
    },
    failed: () => failed,
  };
}

describe("[OPS-01][OPS-AUD-01] vsp_protected_actions_total audit label follows the real tool.invoke append", () => {
  it("[OPS-01][OPS-AUD-01] an accepted consequential action whose tool.invoke audit append failed is counted audit=not_recorded", async () => {
    h = await createGatewayHarness();
    const { sessionRef } = await h.verifiedAveryCall();
    const outage = failToolInvokeAppends(h);
    const r = await h.call({ name: "fixture_commit_change", arguments: commitArgs }, header(sessionRef));
    outage.restore();

    // The commit itself is not blocked by this gateway event (no AUDIT_READ obligation on a commit);
    // the gap must therefore be visible in the metric instead.
    expect(r.status).toBe("SUCCESS");
    expect(r.auditEventId).toBeNull();
    expect(outage.failed()).toBeGreaterThan(0);
    expect(h.metrics.counterValue("vsp_protected_actions_total", { authorization: "valid_decision", audit: "not_recorded" })).toBe(1);
    expect(h.metrics.counterValue("vsp_protected_actions_total", { audit: "recorded_before_ack" })).toBe(0);
  });

  it("[OPS-01][OPS-AUD-01] an accepted consequential action with a durable tool.invoke event is counted audit=recorded_before_ack", async () => {
    h = await createGatewayHarness();
    const { sessionRef } = await h.verifiedAveryCall();
    const r = await h.call({ name: "fixture_commit_change", arguments: commitArgs }, header(sessionRef));
    expect(r.status).toBe("SUCCESS");
    expect(r.auditEventId).not.toBeNull();
    const invoke = (await h.auditRows()).find((row) => row.action === "tool.invoke" && (row.event.evidencePointers as string[]).includes("db://tool_catalog/fixture_commit_change/1.0.0"));
    expect(invoke?.event.eventId).toBe(r.auditEventId);
    expect(h.metrics.counterValue("vsp_protected_actions_total", { authorization: "valid_decision", audit: "recorded_before_ack" })).toBe(1);
    expect(h.metrics.counterValue("vsp_protected_actions_total", { audit: "not_recorded" })).toBe(0);
  });

  it("[OPS-01][OPS-AUD-01] the ratio over a mixed window falls below 100% (1 of 2 accepted actions recorded)", async () => {
    h = await createGatewayHarness();
    const { sessionRef } = await h.verifiedAveryCall();
    expect((await h.call({ name: "fixture_commit_change", arguments: commitArgs }, header(sessionRef))).status).toBe("SUCCESS");
    const outage = failToolInvokeAppends(h);
    expect((await h.call({ name: "fixture_commit_change", arguments: commitArgs }, header(sessionRef))).status).toBe("SUCCESS");
    outage.restore();
    const recorded = h.metrics.counterValue("vsp_protected_actions_total", { audit: "recorded_before_ack" });
    const total = h.metrics.counterValue("vsp_protected_actions_total");
    expect(total).toBe(2);
    expect(recorded / total).toBe(0.5);
  });

  it("[OPS-AUD-01] non-consequential and non-accepted calls are not counted, whatever the audit result", async () => {
    h = await createGatewayHarness();
    const { sessionRef } = await h.verifiedAveryCall();
    const outage = failToolInvokeAppends(h);
    await h.call({ name: "fixture_public_faq", arguments: { topic: "portal_login" } }, header(sessionRef));
    h.faults.mode = "failed";
    const failed = await h.call({ name: "fixture_commit_change", arguments: commitArgs }, header(sessionRef));
    outage.restore();
    expect(failed.status).toBe("PERMANENT_FAILURE");
    expect(h.metrics.counterValue("vsp_protected_actions_total")).toBe(0);
  });
});
