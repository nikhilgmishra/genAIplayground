/**
 * The gateway's PINNED tool catalogue as model tools (WP-08; FO-04-19, FO-09-09). Reads the committed, generated
 * catalogue (schemas/tools/catalog.json, JSON Schema 2020-12 input schemas) and turns every definition into the
 * ModelToolSpec a request offers, plus one hand-written synthetic argument set per tool that the catalogue schema
 * accepts. The tests use them to show that the port's tool-call validator compiles the platform's own schemas and
 * refuses calls that break them (security review r3: the catalogue used to be refused as a whole).
 *
 * Synthetic values only (`*_synth*` identifiers, fixed synthetic dates, no caller data).
 */
import { readFileSync } from "node:fs";
import type { ModelToolSpec } from "../../../src/models/port/types.js";

interface CatalogDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const CATALOG_URL = new URL("../../../../schemas/tools/catalog.json", import.meta.url);

/** Every pinned catalogue definition as a model tool (name, description, the catalogue's input schema). */
export function catalogTools(): ModelToolSpec[] {
  const file = JSON.parse(readFileSync(CATALOG_URL, "utf8")) as { definitions: CatalogDefinition[] };
  return file.definitions.map((d) => ({ name: d.name, description: d.description, parameters: d.inputSchema }));
}

const ACTION_A = "act_synthAction00000000001";
const ACTION_B = "act_synthAction00000000002";

/** One argument set per catalogue tool that its input schema accepts (synthetic). */
export const VALID_CATALOG_ARGUMENTS: Readonly<Record<string, Record<string, unknown>>> = {
  begin_verification: { method: "SECURE_LINK", locator: { kind: "PORTAL_USERNAME_HINT", hint: "synth.user01" } },
  commit_appointment_change: { actionId: ACTION_A, digest: "a".repeat(64) },
  create_support_request: { issueCategory: "general_question", linkToAccount: false, urgency: "STANDARD", language: "en" },
  get_appointment_options: { appointmentId: null, fromDate: "2026-11-02", toDate: "2026-11-09" },
  get_authorized_case_status: { supportReference: "SR-ABCD-EFGH" },
  get_claim_status: { claimId: "clm_synthClaim000000000001" },
  get_invoice_status: { invoiceId: null, detail: "LINE_EXPLANATION", serviceDate: "2026-10-01", line: { chargeCode: "SESSION_FEE", amountMinor: 12_500 } },
  get_login_guidance: { portal: "CLIENT_PORTAL", issue: "FORGOT_PASSWORD", language: "en" },
  get_provider_onboarding_status: { providerId: null, detail: "STAGE" },
  get_remittance_status: { practiceId: null, fromDate: "2026-10-01", toDate: "2026-10-15" },
  prepare_appointment_change: { appointmentId: "apt_synthAppointment0000001", startsAt: "2026-11-03T15:00:00Z", modality: "video", slotId: null },
  prepare_billing_review: { invoiceId: "inv_synthInvoice0000000001", reasonCategory: "OTHER" },
  request_human_transfer: { reason: "CALLER_REQUESTED_HUMAN", language: "en", issueCategory: null, accommodations: ["slower_speech"] },
  request_safety_route: { signalSource: "CALLER_REQUEST", concernSubject: "UNKNOWN", language: "en" },
  search_approved_runbook: { intent: "portal_login_help", query: "reset my password", language: "en" },
  submit_billing_review: { actionId: ACTION_B, digest: "b".repeat(64) },
  submit_complaint: { category: "OTHER", wantsCallback: false, language: "en" },
  submit_partner_intake: { requestType: "OTHER", urgency: "STANDARD", language: "en" },
};

/** Calls each catalogue schema refuses: no arguments, an extra (injected) argument, a wrong-typed argument. */
export function invalidCatalogArguments(name: string): Record<string, unknown>[] {
  const valid = VALID_CATALOG_ARGUMENTS[name];
  if (!valid) throw new Error(`no synthetic arguments for catalogue tool ${name}`);
  const first = Object.keys(valid)[0] as string;
  return [{}, { ...valid, injected: "synthetic" }, { ...valid, [first]: { nested: ["synthetic"] } }];
}
