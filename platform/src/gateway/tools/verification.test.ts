/**
 * begin_verification through the REAL gateway pipeline (policy bundle, PGlite audit, identity
 * services, response pre-check) with the kill-switch state shared by the pipeline and the
 * verification service, as the composition root must wire it (identity README, integration
 * contract item 0). LOCAL FIXTURES and SYNTHETIC people only.
 *
 * OPS-KS-01 (caller-facing): while outbound notifications are switched off, the tool answers the
 * human route with the `verification.failed_generic` registry template (DRAFT, pending
 * support-operations review) instead of "a link was sent", identically for real and unknown
 * people (spec section 7 no-enumeration, AUTH-ENUM-01), and the switch reason is recorded on the
 * `tool.invoke` audit event only.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { BusinessServices } from "../../business/services/types.js";
import { PEOPLE } from "../../fixtures/synthetic-world.js";
import { telephony } from "../../identity/identity-harness.fixture.js";
import type { IdentityHarness } from "../../identity/identity-harness.fixture.js";
import { newId } from "../../shared/ids.js";
import { loadDefaultTemplateRegistry } from "../../voice/registry.js";
import { createGatewayHarness } from "../fixtures/harness.fixture.js";
import type { GatewayHarness } from "../fixtures/harness.fixture.js";
import type { ToolModule } from "../ports.js";
import { beginVerificationTool } from "./verification.js";

/** Only what begin_verification reads from the business services: the verification service and the template registry. */
const servicesFor = (identity: IdentityHarness): BusinessServices => ({ deps: { verification: identity.verification, templates: loadDefaultTemplateRegistry() } }) as unknown as BusinessServices;

let h: GatewayHarness;
afterEach(async () => {
  await h?.close();
});

const AVERY_CHANNELS: readonly string[] = PEOPLE.avery.channels.map((c) => c.channelRef);
const REAL = { kind: "NAME_AND_DATE_OF_BIRTH", fullName: PEOPLE.avery.fullName, dateOfBirth: PEOPLE.avery.dateOfBirth };
const UNKNOWN = { kind: "NAME_AND_DATE_OF_BIRTH", fullName: "Nobody Synthetic-Unknown", dateOfBirth: "1999-09-09" };

async function harness(): Promise<GatewayHarness> {
  return createGatewayHarness({ extraTools: ({ identity }) => [beginVerificationTool(servicesFor(identity)) as unknown as ToolModule] });
}

let seq = 0;
/** A fresh call with the role selected, then one begin_verification over the trusted-header binding (fresh key). */
async function begin(method: "SECURE_LINK" | "ONE_TIME_CODE", locator: Record<string, unknown>) {
  const { sessionRef } = await h.startCall(newId("cal"));
  await h.identity.sessions.selectRole(sessionRef, telephony(), "client");
  const idempotencyKey = `idem_synthKsVerify${"abcdefghijklmnopqrstuvwxyz"[seq++ % 26] ?? "z"}Key`;
  return h.call({ name: "begin_verification", arguments: { method, locator }, idempotencyKey }, { sessionRefHeader: sessionRef });
}

/** Everything the conversational layer sees of a result, minus per-request opaque values. */
const view = (r: Awaited<ReturnType<typeof begin>>) => {
  const v = r.status === "SUCCESS" ? (r.data as { verification: { status: string; nextStep: string } }).verification : null;
  return { status: r.status, reasonCode: "reasonCode" in r ? r.reasonCode : null, verification: v ? { status: v.status, nextStep: v.nextStep } : null, speech: r.speech?.templateId ?? null };
};

async function beginAudits(): Promise<{ outcome: string; reason_code: string | null }[]> {
  return (await h.auditRows()).filter((e) => e.action === "tool.invoke" && (e.event.evidencePointers as string[] | undefined)?.some((p) => p.includes("/begin_verification/")));
}

describe("[OPS-KS-01] begin_verification while outbound notifications are switched off (real pipeline)", () => {
  it("[SPEC-7.no-enumeration] [AUTH-ENUM-01] [OPS-KS-01] OUTBOUND_NOTIFICATIONS engaged: real and unknown people get the identical human route with the registry template (DRAFT); nothing is sent; the switch reason is audited, never returned", async () => {
    h = await harness();
    h.killSwitches.state = { ...h.killSwitches.state, outboundNotifications: true };
    const results = [await begin("SECURE_LINK", REAL), await begin("SECURE_LINK", UNKNOWN), await begin("ONE_TIME_CODE", REAL), await begin("ONE_TIME_CODE", UNKNOWN)];
    const expected = { status: "SUCCESS", reasonCode: null, verification: { status: "VERIFICATION_UNAVAILABLE_USE_HUMAN", nextStep: "HUMAN_VERIFICATION" }, speech: "verification.failed_generic" };
    for (const r of results) expect(view(r)).toEqual(expected);
    expect(h.identity.notifications.sent).toEqual([]);
    expect(h.identity.directory.lookups).toBe(0);
    // The reason is evidence only: never in what the caller-facing layer receives.
    for (const r of results) expect(JSON.stringify(r)).not.toContain("KILL_SWITCH");
    const audits = await beginAudits();
    expect(audits).toHaveLength(4);
    for (const a of audits) expect(a).toMatchObject({ outcome: "SUCCEEDED", reason_code: "KILL_SWITCH_OUTBOUND_NOTIFICATIONS" });
  });

  it("[OPS-KS-01] INTEGRATION(notifications) engaged also answers the human route (pipeline policy still allows the begin); the audited reason names the cause", async () => {
    h = await harness();
    h.killSwitches.state = { ...h.killSwitches.state, integrations: ["notifications"] };
    expect(view(await begin("SECURE_LINK", REAL)).verification?.status).toBe("VERIFICATION_UNAVAILABLE_USE_HUMAN");
    expect((await beginAudits()).map((a) => a.reason_code)).toEqual(["KILL_SWITCH_INTEGRATION"]);
    expect(h.identity.notifications.sent).toEqual([]);
  });

  it("[SPEC-7.VERIFY] [OPS-KS-01] control: with the switches clear (or only other integrations switched off) the secure link is sent and the caller hears the match-code prompt; no switch reason is audited", async () => {
    h = await harness();
    h.killSwitches.state = { ...h.killSwitches.state, integrations: ["salesforce"] };
    const real = await begin("SECURE_LINK", REAL);
    const unknown = await begin("SECURE_LINK", UNKNOWN);
    const expected = { status: "SUCCESS", reasonCode: null, verification: { status: "IF_ELIGIBLE_A_LINK_WAS_SENT", nextStep: "APPROVE_SECURE_LINK_IN_PORTAL" }, speech: "verification.secure_link_match_code" };
    expect(view(real)).toEqual(expected);
    expect(view(unknown)).toEqual(expected);
    expect(h.identity.notifications.sent.filter((m) => AVERY_CHANNELS.includes(m.channelRef))).toHaveLength(1);
    for (const a of await beginAudits()) expect(a).toMatchObject({ outcome: "SUCCEEDED", reason_code: null });
  });
});
