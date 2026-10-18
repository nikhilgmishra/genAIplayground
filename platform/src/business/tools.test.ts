/**
 * Tool catalogue consistency (spec section 8 "Tool interface") and the A0 tools
 * (knowledge, login guidance, verification, complaint) over the REAL modules.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPOINTMENTS, CLAIMS, INVOICES, PEOPLE, TENANT_ID } from "../fixtures/synthetic-world.js";
import { staffActor } from "../ops/testing.js";
import { telephony } from "../identity/identity-harness.fixture.js";
import { toolDefinitionFor } from "../gateway/catalog.js";
import { ActionKind, SERVER_ESTABLISHED_FIELDS } from "../protocol/index.js";
import { loadDefaultTemplateRegistry } from "../voice/registry.js";
import { CONTRACT_IDS, RESOLUTION_CONTRACTS } from "./contracts/index.js";
import { expectedContractsDoc, CONTRACTS_DOC } from "./contracts/cli-generate-doc.js";
import { decideOutcome } from "./outcomes.js";
import { BUSINESS_TOOL_NAMES, TOOL_DEFINITIONS } from "../gateway/tools/definitions.js";
import { createBusinessHarness, expectDone, type BusinessHarness } from "./testing/harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");
const catalogue = JSON.parse(readFileSync(resolve(REPO, "policy/vsp/data.json"), "utf8")).vsp.catalogue.actions as Record<
  string,
  { minAssurance: string; fieldMask: string[]; resourceTypes: string[]; class: string }
>;

let h: BusinessHarness;
beforeAll(async () => {
  h = await createBusinessHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; items?: JsonSchema; anyOf?: JsonSchema[]; additionalProperties?: unknown };

/** Property names of a record schema (object or array of objects, possibly nullable). */
function recordKeys(s: JsonSchema | undefined): Record<string, JsonSchema> {
  if (!s) return {};
  if (s.anyOf) return Object.assign({}, ...s.anyOf.map(recordKeys));
  if (s.type === "array" && s.items) return recordKeys(s.items);
  return s.properties ?? {};
}

describe("[SPEC-8.tool-schema] business tool catalogue", () => {
  it("[SPEC-8.tool-schema] every tool builds a strict, pinned catalogue entry (additionalProperties false; no server-established fields)", () => {
    expect(h.business.tools.map((t) => t.definition.name).sort()).toEqual([...BUSINESS_TOOL_NAMES].sort());
    for (const tool of h.business.tools) {
      const def = toolDefinitionFor(tool);
      expect(def.version).toBe("1.0.0");
      const input = JSON.stringify(def.inputSchema);
      for (const f of SERVER_ESTABLISHED_FIELDS) expect(input.includes(`"${f}"`), `${def.name} declares ${f}`).toBe(false);
      for (const f of ["destinationId", "phoneNumber", "password", "cardNumber", "securityCode", "otp", "code"]) expect(input.includes(`"${f}"`), `${def.name} declares ${f}`).toBe(false);
    }
  });

  it("[SPEC-8.tool-schema] permissions are catalogue action names; minAssurance and consequential flags match the policy catalogue", () => {
    for (const def of Object.values(TOOL_DEFINITIONS)) {
      for (const p of def.permissions) {
        const action = catalogue[p];
        expect(action, `${def.name}: ${p}`).toBeDefined();
        expect(def.minAssurance).toBe(action?.minAssurance);
      }
      expect(def.consequential).toBe(def.safetyClass === "COMMIT_MUTATION");
      for (const c of def.contracts) expect(CONTRACT_IDS).toContain(c);
    }
  });

  it("[DATA-01] [SPEC-8.tool-schema] every masked record field is in the action's policy field mask (nothing needed is stripped, nothing extra leaves)", () => {
    for (const tool of h.business.tools) {
      const def = toolDefinitionFor(tool);
      const mask = catalogue[def.permissions[0] as string]?.fieldMask ?? [];
      const key = tool.maskTarget.collectionKey;
      if (key === null) continue;
      const record = recordKeys((def.outputSchema as JsonSchema).properties?.[key]);
      for (const [field, schema] of Object.entries(record)) {
        const nested = mask.filter((m) => m.startsWith(`${field}.`)).map((m) => m.slice(field.length + 1));
        if (nested.length > 0) {
          for (const sub of Object.keys(recordKeys(schema))) expect(nested, `${def.name}.${field}.${sub}`).toContain(sub);
        } else {
          expect(mask, `${def.name}.${key}.${field}`).toContain(field);
        }
      }
    }
  });

  it("[SPEC-8.tool-schema] output schemas are strict: an unexpected field is rejected", () => {
    const sample = { handoff: { status: "TRANSFER_REQUESTED", transferId: null, destinationPurpose: "STANDARD_SUPPORT", supportReference: null } };
    expect(h.tool("request_human_transfer").output.safeParse(sample).success).toBe(true);
    expect(h.tool("request_human_transfer").output.safeParse({ ...sample, note: "free text" }).success).toBe(false);
    expect(h.tool("request_human_transfer").output.safeParse({ handoff: { ...sample.handoff, phone: "+15555550100" } }).success).toBe(false);
    for (const tool of h.business.tools) expect((toolDefinitionFor(tool).outputSchema as JsonSchema).additionalProperties).toBe(false);
  });

  it("[SPEC-8.tool-schema] the Talkdesk agent configuration names only tools this catalogue serves", () => {
    const cfg = parseYaml(readFileSync(resolve(REPO, "talkdesk/ai-agent-config.yaml"), "utf8")) as {
      alwaysAvailableTools: { name: string; version: string }[];
      coordinator: { allowedTools: { name: string; version: string }[] };
      agents: { allowedTools: { name: string; version: string }[] }[];
      deterministicSkills: { allowedTools: { name: string; version: string }[] }[];
    };
    const named = [...cfg.alwaysAvailableTools, ...cfg.coordinator.allowedTools, ...cfg.agents.flatMap((a) => a.allowedTools), ...cfg.deterministicSkills.flatMap((s) => s.allowedTools)];
    for (const t of named) {
      expect(BUSINESS_TOOL_NAMES, t.name).toContain(t.name);
      expect(TOOL_DEFINITIONS[t.name as keyof typeof TOOL_DEFINITIONS].version).toBe(t.version);
    }
  });

  it("[OPS-06] docs/resolution-contracts.md is generated from the contract objects (no drift)", () => {
    expect(readFileSync(CONTRACTS_DOC, "utf8")).toBe(expectedContractsDoc());
    for (const c of RESOLUTION_CONTRACTS) expect(c).toMatchObject({ status: "DRAFT", approvedBy: null });
  });

  it("[SPEC-11.templates] every template id the business layer can speak exists in both locales and none is APPROVED", () => {
    const reg = loadDefaultTemplateRegistry();
    const files = [
      ...["appointments", "billing", "intake", "knowledge", "provider", "routing", "verification", "common"].map((f) => resolve(here, `../gateway/tools/${f}.ts`)),
      ...["handoff", "outcomes", "consumers"].map((f) => resolve(here, `${f}.ts`)),
      ...["appointments", "billing", "intake", "cases"].map((f) => resolve(here, `services/${f}.ts`)),
      resolve(here, "support/summaries.ts"),
    ];
    const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const namespaces = new Set(["appointment", "billing", "case", "commitment", "login", "lookup", "knowledge", "remittance", "credentialing", "claim", "invoice", "onboarding", "verification", "support_reference", "transfer", "safety", "human", "action", "language", "clinical", "partner", "complaint"]);
    // Action kinds, dotted policy action names and outbox topics share the dotted shape.
    const notTemplates = new Set<string>([...ActionKind.options, ...Object.keys(catalogue).map((a) => a.replace(":", ".")), "action.committed", "support_request.sync"]);
    const ids = new Set(
      [...src.matchAll(/"([a-z_]+\.[a-z_]+)"/g)]
        .map((m) => m[1] as string)
        .filter((id) => namespaces.has(id.split(".")[0] as string) && !notTemplates.has(id)),
    );
    expect(ids.size).toBeGreaterThan(20);
    const missing: string[] = [];
    for (const id of ids) {
      for (const locale of ["en-US", "es-US"]) {
        const t = reg.get(id, locale);
        if (!t) missing.push(`${id}@${locale}`);
        else expect(t.approval.status, id).not.toBe("APPROVED");
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("[ACT-04] interaction outcome rules", () => {
  const evidence = z.strictObject({
    commitReceiptIds: z.array(z.string()),
    informationProvided: z.boolean(),
    requestAccepted: z.boolean(),
    transferConnected: z.boolean(),
    callerDisconnected: z.boolean(),
    policyDeclined: z.boolean(),
    failed: z.boolean(),
  });
  const arbEvidence = fc.record({
    commitReceiptIds: fc.array(fc.constantFrom("rcp_synthReceipt00000001", "rcp_synthReceipt00000002"), { maxLength: 2 }),
    informationProvided: fc.boolean(),
    requestAccepted: fc.boolean(),
    transferConnected: fc.boolean(),
    callerDisconnected: fc.boolean(),
    policyDeclined: fc.boolean(),
    failed: fc.boolean(),
  });

  it("[ACT-04] RESOLVED only with a verified COMMITTED receipt of the contract's action kind; acceptance, hang-up or an unverified receipt never resolve", () => {
    fc.assert(
      fc.property(arbEvidence, fc.constantFrom(...CONTRACT_IDS, null), fc.subarray(["appointment.reschedule", "appointment.create", "billing.review.submit"] as const), (ev, contractId, kinds) => {
        evidence.parse(ev);
        const d = decideOutcome(contractId, ev, kinds);
        if (d.outcome === "RESOLVED") {
          expect(contractId === "appointment_reschedule@1" || contractId === "appointment_create@1").toBe(true);
          expect(kinds.some((k) => (contractId === "appointment_reschedule@1" ? k === "appointment.reschedule" : k === "appointment.create"))).toBe(true);
          expect(ev.transferConnected).toBe(false);
        }
        if (d.outcome === "TRANSFERRED") expect(ev.transferConnected).toBe(true);
        if (contractId === "billing_review@1") expect(d.outcome).not.toBe("RESOLVED");
        if (kinds.length === 0) expect(d.outcome).not.toBe("RESOLVED");
      }),
      { seed: 20261018, numRuns: 400 },
    );
  });

  it("[ACT-04] a caller hang-up alone is CALLER_DISCONNECTED and no evidence is OUTCOME_UNKNOWN", () => {
    const none = { commitReceiptIds: [], informationProvided: false, requestAccepted: false, transferConnected: false, callerDisconnected: false, policyDeclined: false, failed: false };
    expect(decideOutcome("appointment_reschedule@1", { ...none, callerDisconnected: true }, []).outcome).toBe("CALLER_DISCONNECTED");
    expect(decideOutcome("appointment_reschedule@1", none, []).outcome).toBe("OUTCOME_UNKNOWN");
    expect(decideOutcome("appointment_reschedule@1", { ...none, commitReceiptIds: ["rcp_synthReceipt00000001"] }, []).outcome).toBe("OUTCOME_UNKNOWN");
    expect(decideOutcome("unknown_contract@1", { ...none, informationProvided: true }, []).outcome).toBe("OUTCOME_UNKNOWN");
  });

  it("[ACT-04] a claimed receipt that is not this call's COMMITTED receipt does not resolve (verified against the action index)", async () => {
    const { ctx } = await h.startCall("cal_synthCallOutcome00001");
    const r = await h.business.outcomes.record({
      tenantId: ctx.tenantId,
      callId: ctx.callId,
      contractId: "appointment_reschedule@1",
      evidence: { commitReceiptIds: ["rcp_synthForgedReceipt001"], informationProvided: false, requestAccepted: false, transferConnected: false, callerDisconnected: false, policyDeclined: false, failed: false },
    });
    expect(r.outcome).toBe("OUTCOME_UNKNOWN");
  });
});

describe("A0 tools", () => {
  it("[SPEC-9.retrieval] [AUTH-01] public FAQ search returns approved PUBLIC items with exact citation versions for an unverified caller", async () => {
    const { ctx } = await h.startCall("cal_synthCallFaq000000001");
    const r = expectDone(await h.invoke("search_approved_runbook", ctx, { intent: "portal_login_help", query: "cannot sign in", language: "en" }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    const articles = (r.masked as { articles: { citationId: string; articleId: string }[] }).articles;
    expect(articles.length).toBeGreaterThan(0);
    expect(articles[0]?.citationId).toBe("kb_faq-portal-login-help@v3");
    expect(r.outcome.speech).toMatchObject({ templateId: "login.guidance", sourceRefs: ["kb_faq-portal-login-help@v3"] });
  });

  it("[SPEC-9.retrieval] internal runbooks never come back through the public FAQ tool, even for a verified caller", async () => {
    const { sessionRef } = await h.startCall("cal_synthCallFaq000000002");
    const auth = await h.verify(PEOPLE.avery, sessionRef);
    for (const intent of ["appointment_reschedule", "claim_status", "case_follow_up"] as const) {
      const r = expectDone(await h.invoke("search_approved_runbook", auth, { intent, query: null, language: "en" }));
      if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
      for (const a of (r.masked as { articles: { articleId: string }[] }).articles) expect(a.articleId.startsWith("faq-")).toBe(true);
    }
  });

  it("[SPEC-9.retrieval] no approved answer gives the honest no-answer template, and free-text queries with digits are rejected", async () => {
    const { ctx } = await h.startCall("cal_synthCallFaq000000003");
    const r = expectDone(await h.invoke("search_approved_runbook", ctx, { intent: "provider_onboarding", query: null, language: "es" }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(r.outcome.speech?.templateId).toBe("knowledge.no_answer");
    expect((await h.invoke("search_approved_runbook", ctx, { intent: "payment_help", query: "my card is 4111 1111", language: "en" })).stage).toBe("input");
  });

  it("[SPEC-4.login] login guidance never resets credentials; lockouts go to the trusted human recovery process; no password field exists", async () => {
    const { ctx } = await h.startCall("cal_synthCallLogin0000001");
    const a = expectDone(await h.invoke("get_login_guidance", ctx, { portal: "CLIENT_PORTAL", issue: "FORGOT_PASSWORD", language: "en" }));
    const b = expectDone(await h.invoke("get_login_guidance", ctx, { portal: "CLIENT_PORTAL", issue: "LOCKED_OUT", language: "en" }));
    if (a.outcome.status !== "SUCCESS" || b.outcome.status !== "SUCCESS") throw new Error("expected success");
    expect(a.masked).toMatchObject({ recoveryRoute: "IDENTITY_PROVIDER_SELF_SERVICE_RECOVERY" });
    expect(b.outcome.speech?.templateId).toBe("login.recovery_human");
    expect((await h.invoke("get_login_guidance", ctx, { portal: "CLIENT_PORTAL", issue: "FORGOT_PASSWORD", language: "en", password: "x" })).stage).toBe("input");
    expect(loadDefaultTemplateRegistry().get("login.guidance", "en-US")?.text).toMatch(/can't reset passwords/);
  });

  it("[SPEC-7.no-enumeration] [AUTH-01] begin_verification answers identically for a real and an unknown person; the match code is never a data field, only a typed match_code speech slot", async () => {
    const one = await h.startCall("cal_synthCallVerify000001");
    await h.deps.sessions.selectRole(one.sessionRef, telephony(), "client");
    const known = expectDone(await h.invoke("begin_verification", await h.resolve(one.sessionRef), { method: "SECURE_LINK", locator: { kind: "NAME_AND_DATE_OF_BIRTH", fullName: PEOPLE.avery.fullName, dateOfBirth: "1990-01-01" } }));
    const two = await h.startCall("cal_synthCallVerify000002");
    await h.deps.sessions.selectRole(two.sessionRef, telephony(), "client");
    const unknown = expectDone(await h.invoke("begin_verification", await h.resolve(two.sessionRef), { method: "SECURE_LINK", locator: { kind: "NAME_AND_DATE_OF_BIRTH", fullName: "Nobody Synthetic-Unknown", dateOfBirth: "1999-09-09" } }));
    if (known.outcome.status !== "SUCCESS" || unknown.outcome.status !== "SUCCESS") throw new Error("expected success");
    const k = known.masked as { verification: { status: string; nextStep: string; verificationId: string } };
    const u = unknown.masked as { verification: { status: string; nextStep: string; verificationId: string } };
    expect(k.verification.status).toBe(u.verification.status);
    expect(k.verification.nextStep).toBe(u.verification.nextStep);
    expect(Object.keys(k.verification).sort()).toEqual(["nextStep", "status", "verificationId"]);
    expect(JSON.stringify(known.masked)).not.toMatch(/matchCode|1990-01-01|Synthetic-Client/);
    expect(JSON.stringify(known.outcome)).not.toMatch(/1990-01-01|Synthetic-Client/);
    expect(known.outcome.speech?.templateId).toBe(unknown.outcome.speech?.templateId);
    // Spoken only through the approved-template path; generated for every request, so it reveals nothing.
    expect(known.outcome.speech?.templateId).toBe("verification.secure_link_match_code");
    for (const r of [known, unknown]) expect(String(r.outcome.status === "SUCCESS" ? r.outcome.speech?.slots.matchCode : "")).toMatch(/^[a-z]{3,10}-[a-z]{3,10}$/);
  });

  it("[SAFE-02] [SPEC-4.complaint] an unverified caller can make a complaint; it enters complaint_review and is not linked to an account", async () => {
    const { ctx } = await h.startCall("cal_synthCallComplaint001");
    const r = expectDone(await h.invoke("submit_complaint", ctx, { category: "SERVICE_EXPERIENCE", wantsCallback: false, language: "en" }));
    if (r.outcome.status !== "SUCCESS") throw new Error("expected success");
    const ref = (r.outcome.data as { complaint: { supportReference: string } }).complaint.supportReference;
    const trace = await h.business.supportRequests.trace(ctx.tenantId, ref);
    expect(trace?.supportRequest).toMatchObject({ subjectRef: null, issueCategory: "complaint", restricted: false });
    const wf = await h.workflows.get(ctx.tenantId, trace?.workflowIds[0] as string);
    expect(wf).toMatchObject({ type: "complaint_review", state: "ACCEPTED" });
    expect(r.outcome.speech?.templateId).toBe("commitment.request_accepted_pending_sync");
  });
});

/** One valid argument set per tool (ids are SYNTHETIC fixture ids). */
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  search_approved_runbook: { intent: "payment_help", query: null, language: "en" },
  get_login_guidance: { portal: "CLIENT_PORTAL", issue: "FORGOT_USERNAME", language: "en" },
  begin_verification: { method: "SECURE_LINK", locator: { kind: "PORTAL_USERNAME_HINT", hint: "synthetic.user" } },
  get_appointment_options: { appointmentId: APPOINTMENTS[0].appointmentId, fromDate: "2026-10-20", toDate: "2026-10-31" },
  prepare_appointment_change: { appointmentId: APPOINTMENTS[0].appointmentId, startsAt: "2026-10-22T15:00:00.000Z", modality: null },
  commit_appointment_change: { actionId: "act_synthNoSuchAction00001", digest: "a".repeat(64) },
  get_invoice_status: { invoiceId: INVOICES[0].invoiceId, detail: "BALANCE", serviceDate: null },
  prepare_billing_review: { invoiceId: INVOICES[0].invoiceId, reasonCategory: "OTHER" },
  submit_billing_review: { actionId: "act_synthNoSuchAction00001", digest: "a".repeat(64) },
  get_claim_status: { claimId: CLAIMS[0].claimId },
  get_provider_onboarding_status: { providerId: null, detail: "DOCUMENTS" },
  get_remittance_status: { practiceId: null, fromDate: "2026-09-01", toDate: "2026-10-31" },
  submit_partner_intake: { requestType: "OTHER", urgency: "STANDARD", language: "en" },
  submit_complaint: { category: "SERVICE_EXPERIENCE", wantsCallback: false, language: "en" },
  create_support_request: { issueCategory: "other", linkToAccount: false, urgency: "STANDARD", language: "en" },
  get_authorized_case_status: { supportReference: null },
  request_human_transfer: { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: [] },
  request_safety_route: { signalSource: "CALLER_REQUEST", concernSubject: "UNKNOWN", language: "en" },
};

describe("[AUTH-02] denial matrix over every tool", () => {
  let k: BusinessHarness;
  beforeAll(async () => {
    k = await createBusinessHarness();
  }, 60_000);
  afterAll(async () => {
    await k.close();
  });

  it("[SPEC-8.tool-schema] the sample argument set covers every tool and parses", () => {
    expect(Object.keys(SAMPLE_ARGS).sort()).toEqual([...BUSINESS_TOOL_NAMES].sort());
    for (const [name, args] of Object.entries(SAMPLE_ARGS)) expect(k.tool(name).input.safeParse(args).success, name).toBe(true);
  });

  it("[AUTH-02] [AUTH-05] an unverified (A0) caller is denied every A2 tool by policy, whatever ids it presents; resources resolve server-side", async () => {
    const { ctx } = await k.startCall("cal_synthCallMatrix000001");
    for (const def of Object.values(TOOL_DEFINITIONS)) {
      if (def.minAssurance !== "A2") continue;
      const r = await k.invoke(def.name, ctx, SAMPLE_ARGS[def.name] as Record<string, unknown>);
      expect(r.stage, def.name).toBe("policy");
    }
  });

  it("[AUTH-05] commit tools resolve an unknown action id to a denied resource even for a verified caller", async () => {
    const { sessionRef } = await k.startCall("cal_synthCallMatrix000002");
    const avery = await k.verify(PEOPLE.avery, sessionRef);
    for (const name of ["commit_appointment_change", "submit_billing_review"]) {
      const r = await k.invoke(name, avery, SAMPLE_ARGS[name] as Record<string, unknown>);
      expect(r.stage, name).toBe("policy");
    }
  });

  it("[SAFE-02] [SPEC-13.kill-switches] with AI admission switched off every tool is denied except the safety route and the human transfer", async () => {
    await k.ops.killSwitches.set({ tenantId: TENANT_ID, scope: "AI_ADMISSION", target: "*", engaged: true, reason: "INCIDENT_UNSAFE_OUTPUT", staff: staffActor("supervisor") });
    const { ctx } = await k.startCall("cal_synthCallMatrix000003");
    for (const def of Object.values(TOOL_DEFINITIONS)) {
      const r = await k.invoke(def.name, ctx, SAMPLE_ARGS[def.name] as Record<string, unknown>);
      if (def.safetyClass === "SAFETY_AND_HUMAN_ROUTE") {
        expect(r.stage, def.name).toBe("done");
        if (r.stage === "done") expect(r.outcome.status, def.name).toBe("SUCCESS");
      } else {
        expect(r.stage, def.name).toBe("policy");
        if (r.stage === "policy") expect(r.decision.reasonCodes, def.name).toContain("KILL_SWITCH_AI_ADMISSION");
      }
    }
  });
});
