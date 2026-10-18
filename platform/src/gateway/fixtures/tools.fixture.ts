/**
 * LOCAL TEST FIXTURE tool modules for the gateway's own tests. They are NOT the
 * business tool catalogue (platform/src/gateway/tools/**, owned by the business
 * engineer) and are never registered by the composition root. They exercise
 * every pipeline branch against the real policy bundle actions and SYNTHETIC data.
 */
import { z } from "zod";
import type { SchedulingSystem } from "../../adapters/ports.js";
import { OpaqueId } from "../../protocol/index.js";
import { DependencyError, AccessDeniedError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import type { ToolModule, ToolOutcome } from "../ports.js";

const retry1 = { maxAttempts: 1, backoffMs: 0, jitter: false, retryOn: [] as ("TIMEOUT_BEFORE_SEND" | "CONNECTION_REFUSED" | "HTTP_429" | "HTTP_503")[] };

export type FaultMode = "none" | "not_started" | "unknown" | "failed" | "hang" | "extra_field" | "throw_plain" | "bad_speech";

/** Mutable fault switch shared by the fixture tools (tests flip it). */
export class FixtureFaults {
  mode: FaultMode = "none";
  executions = 0;
  sessionlessExecutions = 0;
  lastCallId: string | null = null;
  effects: string[] = [];
}

const AppointmentRow = z.strictObject({
  appointmentId: OpaqueId,
  subjectId: OpaqueId,
  providerDisplayName: z.string().max(80),
  startsAt: z.string().max(40),
  timeZone: z.string().max(64),
  modality: z.enum(["video", "in_person", "phone"]),
  status: z.enum(["SCHEDULED", "CANCELLED", "COMPLETED"]),
  version: z.string().max(64),
});

const AppointmentsOutput = z.strictObject({ appointments: z.array(AppointmentRow).max(20), count: z.number().int().min(0) });
const AppointmentsInput = z.strictObject({ appointmentId: OpaqueId.optional() });

async function fault<T>(faults: FixtureFaults, ok: () => Promise<T>): Promise<T> {
  faults.executions += 1;
  switch (faults.mode) {
    case "not_started":
      throw new DependencyError("CONNECTION_REFUSED", "NOT_STARTED");
    case "unknown":
      throw new DependencyError("TIMEOUT_AFTER_SEND", "UNKNOWN");
    case "failed":
      throw new DependencyError("DEPENDENCY_REJECTED", "FAILED", false);
    case "throw_plain":
      throw new Error("dependency said: Avery Synthetic-Client 1990-01-01");
    case "hang":
      return new Promise<T>(() => undefined);
    default:
      return ok();
  }
}

/** PROTECTED_READ over the real `appointment:read` policy action (AUDIT_READ obligation, A2, self relationship). */
export function fixtureAppointmentsTool(scheduling: SchedulingSystem, faults: FixtureFaults): ToolModule<z.infer<typeof AppointmentsInput>, z.infer<typeof AppointmentsOutput>> {
  return {
    definition: {
      name: "fixture_get_appointments",
      version: "1.0.0",
      description: "LOCAL TEST FIXTURE: lists the authenticated client's own appointments (synthetic).",
      safetyClass: "PROTECTED_READ",
      dataClassification: "PHI",
      minAssurance: "A2",
      permissions: ["appointment:read"],
      timeoutMs: 1_000,
      retryPolicy: retry1,
      idempotency: "NATURALLY_IDEMPOTENT",
      consequential: false,
      maxInputBytes: 256,
      contracts: [],
    },
    maskTarget: { collectionKey: "appointments", envelopeKeys: ["count"] },
    input: AppointmentsInput,
    output: AppointmentsOutput,
    purpose: () => "caller_self_service",
    async resolveResource(auth) {
      // Authoritative: the record subject comes from the session, never from arguments.
      return { type: "appointment", tenantId: auth.tenantId, subjectId: auth.subjectId, organizationId: null, classification: "PHI", actionDigest: null };
    },
    async execute(ctx) {
      return fault(faults, async () => {
        const subjectId = ctx.auth.subjectId;
        if (!subjectId) throw new AccessDeniedError("SUBJECT_NOT_ESTABLISHED");
        const appts = await scheduling.listAppointments(subjectId);
        const data = {
          appointments: appts.map((a) => ({
            appointmentId: a.appointmentId,
            subjectId: a.subjectId,
            providerDisplayName: a.providerDisplayName,
            startsAt: a.startsAt,
            timeZone: a.timeZone,
            modality: a.modality,
            status: a.status,
            version: a.version,
          })),
          count: appts.length,
        } as z.infer<typeof AppointmentsOutput>;
        if (faults.mode === "extra_field") (data as Record<string, unknown>).internalNote = "unexpected dependency field";
        const first = appts[0];
        type PartialSpeech = { templateId: string; templateVersion: string; responseClass: "PROTECTED_FACT"; slots: Record<string, string>; sourceRefs: string[] };
        const speech: PartialSpeech | null =
          faults.mode === "bad_speech"
            ? { templateId: "appointment.facts", templateVersion: "0.1.0-draft", responseClass: "PROTECTED_FACT" as const, slots: { providerName: "Dr. Morgan" }, sourceRefs: ["apt_synthAveryAppt00001"] }
            : first
              ? {
                  templateId: "appointment.facts",
                  templateVersion: "0.1.0-draft",
                  responseClass: "PROTECTED_FACT" as const,
                  slots: { providerName: "Dr. Morgan", date: first.startsAt.slice(0, 10), time: first.startsAt.slice(11, 16), timeZone: first.timeZone },
                  sourceRefs: [first.appointmentId],
                }
              : null;
        return { status: "SUCCESS", data, speech } satisfies ToolOutcome<z.infer<typeof AppointmentsOutput>>;
      });
    },
  };
}

const FaqInput = z.strictObject({ topic: z.enum(["portal_login", "billing_hours"]) });
const FaqOutput = z.strictObject({ articles: z.array(z.strictObject({ articleId: z.string().max(40), title: z.string().max(80), body: z.string().max(400) })).max(3) });

/** PUBLIC_READ over `public:read` (A0). */
export function fixturePublicFaqTool(faults: FixtureFaults): ToolModule<z.infer<typeof FaqInput>, z.infer<typeof FaqOutput>> {
  return {
    definition: {
      name: "fixture_public_faq",
      version: "1.0.0",
      description: "LOCAL TEST FIXTURE: returns a synthetic approved public FAQ article.",
      safetyClass: "PUBLIC_READ",
      dataClassification: "PUBLIC",
      minAssurance: "A0",
      permissions: ["public:read"],
      timeoutMs: 1_000,
      retryPolicy: { maxAttempts: 3, backoffMs: 10, jitter: false, retryOn: ["CONNECTION_REFUSED"] },
      idempotency: "NATURALLY_IDEMPOTENT",
      consequential: false,
      maxInputBytes: 128,
      contracts: [],
    },
    maskTarget: { collectionKey: "articles", envelopeKeys: [] },
    input: FaqInput,
    output: FaqOutput,
    purpose: () => "public_information",
    async resolveResource(auth) {
      return { type: "knowledge_article", tenantId: auth.tenantId, subjectId: null, organizationId: null, classification: "PUBLIC", actionDigest: null };
    },
    async execute() {
      return fault(faults, async () => ({
        status: "SUCCESS" as const,
        data: { articles: [{ articleId: "kb_synth_portal_login", title: "Portal sign-in help", body: "SYNTHETIC public article body." }] },
        speech: null,
      }));
    },
  };
}

const HumanInput = z.strictObject({
  reason: z.enum(["CALLER_REQUESTED_HUMAN", "CLINICAL_QUESTION", "UNSUPPORTED_LANGUAGE"]),
  language: z.enum(["en", "es"]),
});
const RouteOutput = z.strictObject({ destinationPurpose: z.enum(["STANDARD_SUPPORT", "SAFETY_PRIORITY"]), status: z.enum(["REQUESTED", "QUEUED"]), transferId: OpaqueId.nullable() });

/**
 * SAFETY_AND_HUMAN_ROUTE over `human:request`. The destination comes from trusted
 * configuration only (SAFE-05): the strict input has no destination field at all.
 */
export function fixtureHumanTool(faults: FixtureFaults): ToolModule<z.infer<typeof HumanInput>, z.infer<typeof RouteOutput>> {
  const run = async (callId: string | null): Promise<ToolOutcome<z.infer<typeof RouteOutput>>> => {
    faults.lastCallId = callId;
    return fault(faults, async () => {
      faults.effects.push("human_requested");
      return { status: "PENDING" as const, reasonCode: "TRANSFER_REQUESTED", pendingRef: newId("xfr"), data: { destinationPurpose: "STANDARD_SUPPORT" as const, status: "REQUESTED" as const, transferId: null }, speech: { templateId: "transfer.in_progress", templateVersion: "0.1.0-draft", responseClass: "GENERIC_STATUS" as const, slots: {}, sourceRefs: [] } };
    });
  };
  return {
    definition: {
      name: "fixture_request_human",
      version: "1.0.0",
      description: "LOCAL TEST FIXTURE: requests a human; never requires authentication (SAFE-02).",
      safetyClass: "SAFETY_AND_HUMAN_ROUTE",
      dataClassification: "INTERNAL",
      minAssurance: "A0",
      permissions: ["human:request"],
      timeoutMs: 1_000,
      retryPolicy: retry1,
      idempotency: "NATURALLY_IDEMPOTENT",
      consequential: false,
      maxInputBytes: 256,
      contracts: [],
    },
    maskTarget: { collectionKey: null, envelopeKeys: [] },
    input: HumanInput,
    output: RouteOutput,
    purpose: () => "human_handoff",
    async resolveResource(auth) {
      return { type: "human_handoff", tenantId: auth.tenantId, subjectId: null, organizationId: null, classification: "INTERNAL", actionDigest: null };
    },
    async execute(ctx) {
      return run(ctx.auth.callId);
    },
    async executeWithoutSession(ctx) {
      faults.sessionlessExecutions += 1;
      return run(ctx.callId);
    },
  };
}

const SafetyInput = z.strictObject({ signal: z.enum(["CALLER_REQUEST", "EXPLICIT_PHRASE"]) });

/** SAFETY_AND_HUMAN_ROUTE over `safety:route` WITHOUT a sessionless implementation (tests the honest fallback). */
export function fixtureSafetyToolWithoutSessionless(faults: FixtureFaults): ToolModule<z.infer<typeof SafetyInput>, z.infer<typeof RouteOutput>> {
  return {
    definition: {
      name: "fixture_safety_route",
      version: "1.0.0",
      description: "LOCAL TEST FIXTURE: safety route that has no sessionless implementation.",
      safetyClass: "SAFETY_AND_HUMAN_ROUTE",
      dataClassification: "INTERNAL",
      minAssurance: "A0",
      permissions: ["safety:route"],
      timeoutMs: 1_000,
      retryPolicy: retry1,
      idempotency: "NATURALLY_IDEMPOTENT",
      consequential: false,
      maxInputBytes: 128,
      contracts: [],
    },
    maskTarget: { collectionKey: null, envelopeKeys: [] },
    input: SafetyInput,
    output: RouteOutput,
    purpose: () => "safety_routing",
    async resolveResource(auth) {
      return { type: "safety_route", tenantId: auth.tenantId, subjectId: null, organizationId: null, classification: "INTERNAL", actionDigest: null };
    },
    async execute() {
      return fault(faults, async () => ({ status: "SUCCESS" as const, data: { destinationPurpose: "SAFETY_PRIORITY" as const, status: "REQUESTED" as const, transferId: null }, speech: null }));
    },
  };
}

const IntakeInput = z.strictObject({ category: z.enum(["general_question", "complaint"]), urgency: z.enum(["low", "normal"]) });
const IntakeOutput = z.strictObject({ supportReference: z.string().regex(/^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/), status: z.enum(["ACCEPTED"]) });

/** INTAKE over `support_request:create` with IDEMPOTENCY_KEY_REQUIRED. */
export function fixtureIntakeTool(faults: FixtureFaults): ToolModule<z.infer<typeof IntakeInput>, z.infer<typeof IntakeOutput>> {
  let n = 0;
  return {
    definition: {
      name: "fixture_create_request",
      version: "1.0.0",
      description: "LOCAL TEST FIXTURE: minimal intake that records one synthetic effect per new request.",
      safetyClass: "INTAKE",
      dataClassification: "INTERNAL",
      minAssurance: "A0",
      permissions: ["support_request:create"],
      timeoutMs: 1_000,
      retryPolicy: retry1,
      idempotency: "IDEMPOTENCY_KEY_REQUIRED",
      consequential: false,
      maxInputBytes: 256,
      contracts: [],
    },
    maskTarget: { collectionKey: null, envelopeKeys: [] },
    input: IntakeInput,
    output: IntakeOutput,
    purpose: () => "caller_self_service",
    async resolveResource(auth) {
      return { type: "support_request", tenantId: auth.tenantId, subjectId: null, organizationId: null, classification: "INTERNAL", actionDigest: null };
    },
    async execute() {
      return fault(faults, async () => {
        n += 1;
        faults.effects.push(`intake_${n}`);
        return { status: "SUCCESS" as const, data: { supportReference: n % 2 === 1 ? "SR-ABCD-EFGH" : "SR-JKLM-NPQR", status: "ACCEPTED" as const }, speech: null };
      });
    },
  };
}

const CommitInput = z.strictObject({ actionId: OpaqueId, digest: z.string().regex(/^[a-f0-9]{64}$/) });
const CommitOutput = z.strictObject({ actionId: OpaqueId, receiptId: OpaqueId, status: z.enum(["COMMITTED"]) });

/** COMMIT_MUTATION over `appointment:commit_change` (used for kill-switch, fence and UNKNOWN mapping tests). */
export function fixtureCommitTool(faults: FixtureFaults): ToolModule<z.infer<typeof CommitInput>, z.infer<typeof CommitOutput>> {
  return {
    definition: {
      name: "fixture_commit_change",
      version: "1.0.0",
      description: "LOCAL TEST FIXTURE: digest-bound commit that never reaches a real system.",
      safetyClass: "COMMIT_MUTATION",
      dataClassification: "PHI",
      minAssurance: "A2",
      permissions: ["appointment:commit_change"],
      timeoutMs: 1_000,
      retryPolicy: retry1,
      idempotency: "PREPARED_ACTION_DIGEST",
      consequential: true,
      maxInputBytes: 256,
      contracts: [],
    },
    maskTarget: { collectionKey: null, envelopeKeys: [] },
    input: CommitInput,
    output: CommitOutput,
    purpose: () => "caller_self_service",
    async resolveResource(auth, input) {
      return { type: "appointment", tenantId: auth.tenantId, subjectId: auth.subjectId, organizationId: null, classification: "PHI", actionDigest: input.digest };
    },
    async execute(_ctx, input) {
      return fault(faults, async () => {
        faults.effects.push("committed");
        const data = { actionId: input.actionId, receiptId: newId("rcp"), status: "COMMITTED" as const };
        if (faults.mode === "extra_field") (data as Record<string, unknown>).providerFreeText = "dependency free text";
        return { status: "SUCCESS" as const, data, speech: null };
      });
    },
  };
}
