/**
 * Human request and safety route (spec section 10; SAFE-02, SAFE-03, SAFE-04, SAFE-05).
 *
 * - Neither route requires authentication: ctx may be null (unknown / invalid session).
 * - The destination comes ONLY from the trusted DestinationConfig allowlist, chosen by
 *   purpose and language (unsupported languages go to the interpreter destination). The
 *   only exception is a console-initiated transfer, whose staff-selected destinationId
 *   must itself be an allowlisted entry (anything else is refused, nothing dialled);
 *   caller, model and tool input can never carry one.
 * - The HandoffPackage is strict and template-assembled: assurance and its limits, the
 *   authorized subject (A2+ only), consent, receipts, pending and unresolved work, the
 *   support reference, language, accommodations and the safety routing reason. Clinical
 *   statements are never included (clinicalStatementsIncluded=false).
 * - Verified sessions get a single-use transfer_receiver assertion for the receiver.
 * - Safety: the priority transfer is requested first; pending mutations are invalidated
 *   and SAFETY_ESCALATION is applied to the session concurrently. Nothing that can fail
 *   (database, audit, KV, signing, Salesforce) is allowed to block or abandon the route;
 *   the independent Studio route remains the backstop.
 * - The handoff id is deterministic per call and priority, so a repeated request returns
 *   the active journey instead of dialling twice.
 */
import { HandoffPackage, OpaqueId, meetsAssurance } from "../protocol/index.js";
import { AccessDeniedError, ValidationError } from "../shared/errors.js";
import type { AuthContext, HandoffPackage as HandoffPackageT, IssueCategory, TransferReason } from "../protocol/index.js";
import type { DestinationConfig } from "../config/ports.js";
import type { SafetySignal } from "../safety/ports.js";
import { buildAuditInput } from "../audit/build-input.js";
import { sha256Hex } from "../shared/canonical.js";
import { iso } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import { randomBytes } from "node:crypto";
import type { HandoffResult, HandoffService, ToolDeps } from "./contract.js";
import type { InteractionIndex } from "./interactions.js";
import { UNKNOWN_CONSENT, auditSessionRef, reasonOf } from "./shared.js";
import type { PgSupportRequestService } from "./support/support-request-service.js";

type Purpose = DestinationConfig["purpose"];
type Accommodation = HandoffPackageT["accommodations"][number];

const PURPOSE_BY_CATEGORY: Partial<Record<IssueCategory, Purpose>> = {
  billing_question: "BILLING_SPECIALIST",
  billing_dispute: "BILLING_SPECIALIST",
  claim_status: "BILLING_SPECIALIST",
  provider_onboarding: "PROVIDER_SUPPORT",
  credentialing_documents: "PROVIDER_SUPPORT",
  remittance: "PROVIDER_SUPPORT",
  partner_intake: "PARTNER_SUPPORT",
  clinical_question_redirected: "CLINICAL_ROUTE",
  safety_concern: "SAFETY_PRIORITY",
};

const baseLanguage = (lang: string): string => lang.toLowerCase().split("-")[0] ?? lang;

const supports = (d: DestinationConfig, lang: string): boolean => d.languages.includes("*") || d.languages.includes(baseLanguage(lang));

/** Trusted-configuration destination for a purpose and language (SAFE-05). */
export function resolveDestination(
  destinations: readonly DestinationConfig[],
  purpose: Purpose,
  language: string,
): { destination: DestinationConfig; interpreter: boolean } | null {
  const byPurpose = (p: Purpose) => destinations.filter((d) => d.purpose === p);
  const primary = byPurpose(purpose);
  const inLanguage = primary.find((d) => supports(d, language));
  if (inLanguage) return { destination: inLanguage, interpreter: purpose === "INTERPRETER" };
  if (purpose === "SAFETY_PRIORITY") {
    // Never block a safety route on language: use the safety destination and ask for an interpreter.
    const any = primary[0];
    return any ? { destination: any, interpreter: true } : null;
  }
  const interpreter = byPurpose("INTERPRETER").find((d) => supports(d, language));
  if (interpreter) return { destination: interpreter, interpreter: true };
  const general = byPurpose("STANDARD_SUPPORT")[0] ?? byPurpose("OUTAGE_CONTINUITY")[0];
  return general ? { destination: general, interpreter: !supports(general, language) } : null;
}

export function purposeFor(reason: TransferReason, issueCategory: IssueCategory | null): Purpose {
  switch (reason) {
    case "SAFETY_PRIORITY":
      return "SAFETY_PRIORITY";
    case "CLINICAL_QUESTION":
      return "CLINICAL_ROUTE";
    case "UNSUPPORTED_LANGUAGE":
      return "INTERPRETER";
    default:
      return (issueCategory && PURPOSE_BY_CATEGORY[issueCategory]) || "STANDARD_SUPPORT";
  }
}

const LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;
const normalizeLanguage = (l: string): string => {
  const [a, b] = l.split("-");
  const v = b ? `${(a ?? "").toLowerCase()}-${b.toUpperCase()}` : (a ?? "").toLowerCase();
  return LANGUAGE.test(v) ? v : "en";
};

function assuranceLimits(ctx: AuthContext | null): string[] {
  if (!ctx) return ["SESSION_UNRESOLVED_NO_ACCOUNT_CONTEXT"];
  const limits: string[] = [];
  if (!meetsAssurance(ctx.assurance, "A2")) limits.push("NOT_ACCOUNT_AUTHENTICATED_NO_PROTECTED_DISCLOSURE");
  if (!ctx.stepUp) limits.push("NO_TRANSACTION_STEP_UP");
  if (ctx.consent.recording !== "GRANTED" && ctx.consent.recording !== "NOT_REQUIRED") limits.push(`RECORDING_CONSENT_${ctx.consent.recording}`);
  if (ctx.riskFlags.length > 0) limits.push("RISK_FLAGS_PRESENT");
  return limits.slice(0, 8);
}

const SAFETY_CONTEXT_TIMEOUT_MS = 250;
const STANDARD_CONTEXT_TIMEOUT_MS = 2000;

async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p.catch(() => fallback), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class BusinessHandoffService implements HandoffService {
  constructor(
    private readonly deps: ToolDeps,
    private readonly interactions: InteractionIndex,
    private readonly support: PgSupportRequestService,
  ) {}

  async requestHuman(input: Parameters<HandoffService["requestHuman"]>[0]): Promise<HandoffResult> {
    const ctx = this.usableContext(input.ctx, input.tenantId, input.callId);
    const language = normalizeLanguage(input.language);
    const purpose = purposeFor(input.reason, input.issueCategory);
    const initiatedBy = input.initiatedBy ?? null;
    if (initiatedBy !== null && !OpaqueId.safeParse(initiatedBy.staffId).success) throw new ValidationError("HANDOFF_INITIATOR_INVALID");
    // A staff-selected destination (console) must be in the trusted allowlist (SAFE-05); nothing else can name one.
    const requested = input.destinationId ?? null;
    const chosen = requested === null ? null : this.deps.destinations.find((d) => d.destinationId === requested);
    if (requested !== null && !chosen) {
      this.deps.logger.warn("handoff.destination_refused", { reasonCode: "DESTINATION_NOT_ALLOWLISTED" });
      throw new AccessDeniedError("DESTINATION_NOT_ALLOWLISTED");
    }
    const resolved = chosen ? { destination: chosen, interpreter: !supports(chosen, language) } : resolveDestination(this.deps.destinations, purpose, language);
    const accommodations = new Set<Accommodation>(input.accommodations ?? []);
    if (!resolved) {
      this.deps.logger.error("handoff.no_destination", { reasonCode: "DESTINATION_NOT_CONFIGURED" });
      return { handoffId: newId("hnd"), transferId: null, destinationId: "dst_unconfigured", journey: null, speechTemplateId: "transfer.failed_next_route" };
    }
    if (resolved.interpreter) accommodations.add("interpreter");
    const context = await within(this.callContext(input.tenantId, input.callId), STANDARD_CONTEXT_TIMEOUT_MS, { receipts: [], pending: [], unresolved: [] });
    const sr = await within(this.handoffRecord(ctx, input.tenantId, input.callId, input.reason, input.issueCategory, language), STANDARD_CONTEXT_TIMEOUT_MS, null);
    const handoffId = await this.handoffIdFor(input.tenantId, input.callId, "STANDARD");
    const pkg = await this.buildPackage({
      handoffId,
      tenantId: input.tenantId,
      callId: input.callId,
      ctx,
      reason: input.reason,
      destinationId: resolved.destination.destinationId,
      issueCategory: input.issueCategory ?? "other",
      language,
      accommodations: [...accommodations],
      context,
      supportReference: sr?.referenceNumber ?? null,
      safetyRoutingReason: null,
    });
    this.deps.metrics.increment("vsp_human_demand_total", { reason: input.reason });
    const speechTemplateId =
      input.reason === "CLINICAL_QUESTION" ? "clinical.boundary" : accommodations.has("interpreter") ? "language.interpreter_route" : "transfer.in_progress";
    try {
      const journey = await this.deps.transfers.requestTransfer(pkg);
      await this.auditHandoff(pkg, ctx, "handoff.requested", null, initiatedBy);
      return { handoffId, transferId: journey.currentTransferId, destinationId: pkg.destinationId, journey, speechTemplateId, supportReference: pkg.supportReference };
    } catch (err) {
      this.deps.logger.error("handoff.transfer_request_failed", { handoffId, reasonCode: reasonOf(err) });
      await this.auditHandoff(pkg, ctx, "handoff.transfer_failed", reasonOf(err, "TRANSFER_REQUEST_FAILED"), initiatedBy);
      // The independent Studio human route remains available (spec section 3).
      return { handoffId, transferId: null, destinationId: pkg.destinationId, journey: null, speechTemplateId: "transfer.failed_next_route", supportReference: pkg.supportReference };
    }
  }

  async requestSafetyRoute(input: Parameters<HandoffService["requestSafetyRoute"]>[0]): Promise<HandoffResult> {
    const ctx = this.usableContext(input.ctx, input.tenantId, input.callId);
    const language = normalizeLanguage(input.locale);
    const resolved = resolveDestination(this.deps.destinations, "SAFETY_PRIORITY", language);
    // The coordinator substitutes its configured safety destination if this is ever invalid.
    const destinationId = resolved?.destination.destinationId ?? "dst_safety_priority";
    const accommodations: Accommodation[] = resolved?.interpreter ? ["interpreter"] : [];
    const context = await within(this.callContext(input.tenantId, input.callId), SAFETY_CONTEXT_TIMEOUT_MS, { receipts: [], pending: [], unresolved: [] });
    const handoffId = await within(this.handoffIdFor(input.tenantId, input.callId, "SAFETY"), SAFETY_CONTEXT_TIMEOUT_MS, this.deterministicHandoffId(input.tenantId, input.callId, "SAFETY", 0));
    const pkg = await this.buildPackage(
      {
        handoffId,
        tenantId: input.tenantId,
        callId: input.callId,
        ctx,
        reason: "SAFETY_PRIORITY",
        destinationId,
        issueCategory: "safety_concern",
        language,
        accommodations,
        context,
        supportReference: null,
        safetyRoutingReason: input.signals[0]?.source ?? "HUMAN_INTERVENTION",
      },
      SAFETY_CONTEXT_TIMEOUT_MS,
    );

    // Stop administrative work and flag the session concurrently; never awaited before dialling.
    const escalation = this.escalate(ctx);
    let journey: HandoffResult["journey"] = null;
    try {
      journey = await this.deps.transfers.requestTransfer(pkg, { validatedSafetyEventAt: iso(input.validatedAt) });
    } catch (err) {
      this.deps.logger.error("handoff.safety_transfer_request_failed", { handoffId, reasonCode: reasonOf(err) });
    }
    await escalation;
    // Evidence and the restricted record for the safety owner queue come after the route was
    // initiated, bounded in time, and never fail the route.
    await within(this.auditHandoff(pkg, ctx, journey ? "handoff.safety_requested" : "handoff.safety_transfer_failed", journey ? null : "TRANSFER_REQUEST_FAILED"), STANDARD_CONTEXT_TIMEOUT_MS, undefined);
    await within(this.safetyRecord(ctx, input.tenantId, input.callId, pkg.safetyRoutingReason ?? "HUMAN_INTERVENTION", language), STANDARD_CONTEXT_TIMEOUT_MS, undefined);
    return { handoffId, transferId: journey?.currentTransferId ?? null, destinationId: journey?.routePlan[journey.routeIndex] ?? destinationId, journey, speechTemplateId: "safety.acknowledgment" };
  }

  // ------------------------------------------------------------------ helpers

  /** A context from another call or tenant is ignored (treated as unauthenticated). */
  private usableContext(ctx: AuthContext | null, tenantId: string, callId: string): AuthContext | null {
    if (!ctx || ctx.tenantId !== tenantId || ctx.callId !== callId || ctx.revoked) return null;
    if (Date.parse(ctx.expiresAt) <= this.deps.clock.now().getTime()) return null;
    return ctx;
  }

  private async escalate(ctx: AuthContext | null): Promise<void> {
    if (!ctx) return;
    await Promise.allSettled([
      within(this.deps.actions.invalidatePending(ctx.sessionRef, "SAFETY_ESCALATION"), 2000, 0),
      within(this.deps.sessions.applyChange(ctx.sessionRef, ctx.integration, { kind: "SAFETY_ESCALATION" }), 2000, null),
    ]).then((results) => {
      for (const r of results) if (r.status === "rejected") this.deps.logger.warn("handoff.safety_escalation_partial", { reasonCode: reasonOf(r.reason) });
    });
  }

  private deterministicHandoffId(tenantId: string, callId: string, priority: "SAFETY" | "STANDARD", n: number): string {
    return `hnd_${Buffer.from(sha256Hex(`vsp.handoff.v1\u0000${tenantId}\u0000${callId}\u0000${priority}\u0000${n}`), "hex").toString("base64url").slice(0, 32)}`;
  }

  /** Active journey for this call and priority is reused; a finished one gets the next id. */
  private async handoffIdFor(tenantId: string, callId: string, priority: "SAFETY" | "STANDARD"): Promise<string> {
    for (let n = 0; n < 8; n++) {
      const id = this.deterministicHandoffId(tenantId, callId, priority, n);
      const existing = await this.deps.transfers.get(id).catch(() => null);
      if (!existing || existing.status === "ROUTING" || existing.status === "CONNECTED") return id;
    }
    return newId("hnd");
  }

  private async callContext(tenantId: string, callId: string): Promise<{ receipts: string[]; pending: string[]; unresolved: string[] }> {
    const records = await this.interactions.forCall(tenantId, callId);
    const receipts = records.filter((r) => r.receiptOutcome === "COMMITTED" && r.receiptId).map((r) => r.receiptId as string);
    const pending: string[] = [];
    const unresolved: string[] = [];
    for (const r of records) {
      if (r.receiptOutcome === "COMMITTED") continue;
      const a = await this.deps.actions.get(tenantId, r.actionId).catch(() => null);
      if (!a) continue;
      if (a.state === "PREPARED" || a.state === "CONFIRMED") {
        pending.push(a.actionId);
        unresolved.push(`PENDING_CONFIRMATION:${a.kind}`);
      } else if (a.state === "UNKNOWN" || a.state === "COMMITTING") {
        unresolved.push(`OUTCOME_UNKNOWN_RECONCILING:${a.kind}`);
      }
    }
    return { receipts: receipts.slice(0, 16), pending: pending.slice(0, 16), unresolved: unresolved.slice(0, 8) };
  }

  private async buildPackage(
    p: {
      handoffId: string;
      tenantId: string;
      callId: string;
      ctx: AuthContext | null;
      reason: TransferReason;
      destinationId: string;
      issueCategory: IssueCategory;
      language: string;
      accommodations: Accommodation[];
      context: { receipts: string[]; pending: string[]; unresolved: string[] };
      supportReference: string | null;
      safetyRoutingReason: SafetySignal["source"] | null;
    },
    assertionTimeoutMs = STANDARD_CONTEXT_TIMEOUT_MS,
  ): Promise<HandoffPackageT> {
    const ctx = p.ctx;
    const authorizedSubjectRef = ctx && ctx.subjectId && meetsAssurance(ctx.assurance, "A2") ? ctx.subjectId : null;
    const assertion = ctx ? await within(this.assertionFor(ctx, p.destinationId), assertionTimeoutMs, null) : null;
    const summary = `Transfer reason ${p.reason}. Stated issue category ${p.issueCategory}. Caller assurance ${ctx?.assurance ?? "A0"}. Pending actions ${p.context.pending.length}. Committed receipts ${p.context.receipts.length}.`;
    return HandoffPackage.parse({
      handoffId: p.handoffId,
      tenantId: p.tenantId,
      callId: p.callId,
      sessionGeneration: ctx?.sessionGeneration ?? 1,
      reason: p.reason,
      destinationId: p.destinationId,
      statedIssue: p.issueCategory,
      issueSummary: summary,
      assurance: ctx?.assurance ?? "A0",
      assuranceLimits: assuranceLimits(ctx),
      authorizedSubjectRef,
      consent: ctx?.consent ?? UNKNOWN_CONSENT,
      actionReceiptIds: p.context.receipts,
      pendingActionIds: p.context.pending,
      unresolvedTasks: p.context.unresolved,
      supportReference: p.supportReference,
      language: p.language,
      accommodations: [...new Set(p.accommodations)].slice(0, 5),
      safetyRoutingReason: p.safetyRoutingReason,
      clinicalStatementsIncluded: false,
      verificationAssertion: assertion,
      createdAt: iso(this.deps.clock.now()),
    });
  }

  /** Single-use transfer_receiver assertion for verified sessions; null otherwise. */
  private async assertionFor(ctx: AuthContext, destinationId: string): Promise<string | null> {
    if (!ctx.actorId || !ctx.selectedRole || !meetsAssurance(ctx.assurance, "A1")) return null;
    return this.deps.assertions.mint(
      {
        aud: `vsp-transfer-receiver.${destinationId}`,
        sub: ctx.actorId,
        nonce: randomBytes(32).toString("base64url"),
        sid: auditSessionRef(ctx) as string,
        gen: ctx.sessionGeneration,
        call: ctx.callId,
        asr: ctx.assurance === "A3" ? "A2" : ctx.assurance,
        role: ctx.selectedRole,
        purpose: "transfer_receiver",
        actions: [],
      },
      120,
    );
  }

  private async handoffRecord(ctx: AuthContext | null, tenantId: string, callId: string, reason: TransferReason, issueCategory: IssueCategory | null, language: string) {
    return this.support.createRecord({
      tenantId,
      callId,
      audience: ctx?.selectedRole ?? null,
      subjectRef: ctx && ctx.subjectId && meetsAssurance(ctx.assurance, "A2") ? ctx.subjectId : null,
      organizationRef: null,
      actorRef: ctx?.actorId ?? null,
      sessionRef: auditSessionRef(ctx),
      sessionGeneration: ctx?.sessionGeneration ?? null,
      issueCategory: issueCategory ?? "other",
      disposition: "OUTCOME_UNKNOWN",
      summaryTemplateId: "summary.human_handoff",
      summarySlots: { reason, issueCategory: issueCategory ?? "other" },
      attempted: ["human.request"],
      commitReceiptIds: [],
      nextStep: "HUMAN_RECEIVER_FOLLOW_UP",
      restricted: false,
      priority: "P3_STANDARD",
      ownerQueue: "q_support_general",
      language,
      consent: ctx?.consent ?? UNKNOWN_CONSENT,
      creationKey: sha256Hex(`vsp.handoff.record.v1:${tenantId}:${callId}:${reason}`),
    });
  }

  private async safetyRecord(ctx: AuthContext | null, tenantId: string, callId: string, signalSource: string, language: string): Promise<void> {
    try {
      await this.support.createRecord({
        tenantId,
        callId,
        audience: ctx?.selectedRole ?? null,
        subjectRef: ctx && ctx.subjectId && meetsAssurance(ctx.assurance, "A2") ? ctx.subjectId : null,
        organizationRef: null,
        actorRef: ctx?.actorId ?? null,
        sessionRef: auditSessionRef(ctx),
        sessionGeneration: ctx?.sessionGeneration ?? null,
        issueCategory: "safety_concern",
        disposition: "OUTCOME_UNKNOWN",
        summaryTemplateId: "summary.safety_route",
        summarySlots: { signalSource },
        attempted: ["safety.route"],
        commitReceiptIds: [],
        nextStep: "SAFETY_RESPONDER_FOLLOW_UP",
        restricted: true,
        priority: "P1_SAFETY",
        ownerQueue: "q_safety_responders",
        language,
        consent: ctx?.consent ?? UNKNOWN_CONSENT,
        creationKey: sha256Hex(`vsp.safety.record.v1:${tenantId}:${callId}`),
      });
    } catch (err) {
      this.deps.logger.warn("handoff.safety_record_not_created", { reasonCode: reasonOf(err) });
    }
  }

  /** A console-initiated transfer is audited with the staff member as the actor (sourceComponent console). */
  private async auditHandoff(pkg: HandoffPackageT, ctx: AuthContext | null, action: string, reasonCode: string | null, initiatedBy: { staffId: string } | null = null): Promise<void> {
    try {
      await this.deps.audit.appendStandalone(
        buildAuditInput(
          {
            tenantId: pkg.tenantId,
            correlationId: pkg.handoffId,
            sourceComponent: initiatedBy ? "console" : "gateway",
            action,
            outcome: reasonCode ? "FAILED" : "PENDING",
            actorRef: initiatedBy?.staffId ?? ctx?.actorId ?? null,
            subjectRef: pkg.authorizedSubjectRef,
            role: ctx?.selectedRole ?? null,
            callId: pkg.callId,
            sessionRef: auditSessionRef(ctx),
            sessionGeneration: pkg.sessionGeneration,
            assurance: pkg.assurance,
            versions: this.deps.versions,
            evidencePointers: [`handoff:${pkg.handoffId}`, `db://destinations/${pkg.destinationId}`],
            reasonCode,
          },
          this.deps.clock,
        ),
      );
    } catch (err) {
      // Audit unavailability never blocks a human or safety route (OPS-02, SAFE-03).
      this.deps.logger.warn("handoff.audit_unavailable", { handoffId: pkg.handoffId, reasonCode: reasonOf(err) });
    }
  }
}
