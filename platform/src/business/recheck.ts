/**
 * Pre-disclosure / pre-material-change recheck for the durable work the business layer
 * accepts (spec section 9: "Before later disclosure or a material change, recheck consent,
 * representation, account state and relevant policy. Snapshot policies for reproducibility
 * but apply revocations and updated legal constraints immediately. Record when new policy
 * changes a pending action").
 *
 * PgWorkflowEngine calls `recheck()` inside the guarded transition's transaction, AFTER the
 * durable action grant was checked valid for the transition's declared action. Every fact
 * is CURRENT and server-established; nothing comes from the workflow event, the staff
 * member's request, a caller or a model:
 *   1. rule: the grant action must have a rule here (closed table, ENGINEERING DEFAULT pending
 *      the policy owner); anything else fails closed (RECHECK_RULE_UNDEFINED);
 *   2. grant: subject and actor of the durable grant (read in the transition's transaction);
 *   3. record: the authoritative record the disclosure is about (the invoice from the billing
 *      system, or the accepted support request) must still name the grant's subject or
 *      organization; an unlinked (unverified) complaint has no account to disclose to; the
 *      grant must name an actor;
 *   4. representation: the grant actor's role is reconstructed from the authoritative
 *      directory (self first, never combined); anyone else must hold a current legal
 *      authority for the subject (policy evaluates the registry facts, incl. expiry);
 *   5. account state: the subject's (and a representative's own) account must be ACTIVE;
 *   6. consent: the consent registry's CURRENT record for the person wins (a revocation
 *      applies immediately); without one, the consent captured with the accepted work;
 *      UNKNOWN is never consent;
 *   7. kill switches: the current snapshot; a material change is refused while writes are off;
 *   8. policy: the CURRENT bundle evaluates the rule's action for purpose durable_follow_up
 *      with the reconstructed actor/subject. Its version is returned, so the engine records a
 *      newer policy that still allows (POLICY_VERSION_CHANGED) and records a denial as
 *      POLICY_CHANGED_PENDING_ACTION.
 * A deny returns a reason code (the engine records POLICY_CHANGED_PENDING_ACTION and a human
 * owns the pending action). An unreadable dependency throws: the engine then refuses the
 * transition without recording a policy change (it was not one).
 *
 * Assurance: the reconstructed policy view carries A2 because the business layer issues a
 * grant naming an account subject or an organization only for work accepted at A2 (billing
 * review commit: billing:submit_review A2; partner intake: partner path A2; complaint link:
 * A2 only, see services/intake.ts). An unlinked complaint's grant names the support request
 * and is refused at step 3 before any policy evaluation.
 *
 * Content rules: opaque ids, codes and versions only; no PHI in logs or reason codes.
 */
import type { BillingSystem, IdentityDirectory, RelationshipDirectory } from "../adapters/ports.js";
import type { Queryable } from "../db/types.js";
import { silentLogger } from "../observability/logger.js";
import type { Logger } from "../observability/ports.js";
import { snapshotFromEngaged } from "../ops/kill-switches.js";
import type { PolicyEngine } from "../policy/ports.js";
import { ConsentValue, PolicyInput, RelationshipFact } from "../protocol/index.js";
import type { Environment, Role, WorkflowType } from "../protocol/index.js";
import { ValidationError } from "../shared/errors.js";
import type { PreDisclosureRecheck, RecheckContext, RecheckResult } from "../workflows/recheck.js";

export type AccountStateValue = "ACTIVE" | "LOCKED" | "RECOVERY_IN_PROGRESS" | "CLOSED";

/**
 * Current account state of a person, from the identity owner's directory. null = unknown
 * (fails closed). The IdentityDirectory port is keyed by account id, which a durable grant
 * does not carry; implementations map the server-established actor or subject to it.
 */
export interface AccountStateLookup {
  readonly kind: "local_fixture" | "live";
  forActor(actorId: string): Promise<AccountStateValue | null>;
  forSubject(subjectId: string): Promise<AccountStateValue | null>;
}

/**
 * Current consent for later automated processing and disclosure (spec section 9), kept by
 * the trusted backend, never set from a caller statement. null = no record since the work
 * was accepted (the consent captured with the accepted work then applies).
 */
export interface ConsentRegistry {
  readonly kind: "local_fixture" | "live";
  current(tenantId: string, personRef: string): Promise<{ automatedProcessing: ConsentValue; recordedAt: string } | null>;
}

interface RecheckRule {
  /** Only the workflow type whose definition declares this grant action. */
  workflowType: WorkflowType;
  /** Policy action re-evaluated for purpose durable_follow_up. */
  policyAction: "invoice:read" | "case:read";
  /** account: the grant names a person's subject; organization: a partner organization. */
  scope: "account" | "organization";
  /** The authoritative record the disclosure or change is about. */
  record: "invoice" | "support_request";
}

/**
 * Rules per durable grant action (ENGINEERING DEFAULT pending the policy owner; spec section
 * 9 and docs/resolution-contracts.md). Grant actions of workflows the business layer does not
 * start (callback outreach, claim findings, provider documents) have no rule: fail closed.
 */
export const RECHECK_RULES: Readonly<Record<string, RecheckRule>> = Object.freeze({
  "billing.review.commit": { workflowType: "billing_dispute_review", policyAction: "invoice:read", scope: "account", record: "invoice" },
  "billing.review.decision_notice": { workflowType: "billing_dispute_review", policyAction: "invoice:read", scope: "account", record: "invoice" },
  "billing.review.outcome_notice": { workflowType: "billing_dispute_review", policyAction: "invoice:read", scope: "account", record: "invoice" },
  "complaint.response.disclose": { workflowType: "complaint_review", policyAction: "case:read", scope: "account", record: "support_request" },
  "partner.onboarding.decision_notice": { workflowType: "partner_onboarding", policyAction: "case:read", scope: "organization", record: "support_request" },
  "partner.onboarding.activate": { workflowType: "partner_onboarding", policyAction: "case:read", scope: "organization", record: "support_request" },
});

/** Reason codes this recheck returns itself (policy denials return the policy's own first reason code). */
export const RECHECK_REASONS = [
  "RECHECK_RULE_UNDEFINED",
  "RECHECK_GRANT_NOT_FOUND",
  "RECHECK_ACTOR_NOT_ESTABLISHED",
  "RECHECK_RECORD_UNAVAILABLE",
  "RECHECK_RECORD_SUBJECT_MISMATCH",
  "RECHECK_SUBJECT_NOT_ESTABLISHED",
  "REPRESENTATION_NOT_ESTABLISHED",
  "AFFILIATION_NOT_ESTABLISHED",
  "ACCOUNT_CLOSED",
  "ACCOUNT_LOCKED",
  "ACCOUNT_RECOVERY_IN_PROGRESS",
  "ACCOUNT_STATE_UNKNOWN",
  "CONSENT_REVOKED",
  "CONSENT_DECLINED",
  "CONSENT_NOT_ESTABLISHED",
  "KILL_SWITCH_WRITES",
] as const;
export type RecheckReason = (typeof RECHECK_REASONS)[number];

export interface BusinessPreDisclosureRecheckOptions {
  policy: PolicyEngine;
  directory: Pick<IdentityDirectory, "selfSubjectId" | "organizationFor">;
  relationships: RelationshipDirectory;
  billing: Pick<BillingSystem, "getInvoice">;
  accounts: AccountStateLookup;
  consent: ConsentRegistry;
  environment: Environment;
  logger?: Logger;
}

interface GrantRow {
  subject_id: string;
  actor_id: string | null;
  source_ref: string;
  issued_at: Date | string;
  expires_at: Date | string;
}

interface RecordView {
  subjectRef: string | null;
  organizationRef: string | null;
}

const isoOf = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const CONSENT_OK: ReadonlySet<ConsentValue> = new Set<ConsentValue>(["GRANTED", "NOT_REQUIRED"]);
const REPRESENTATIVE_FACTS: ReadonlySet<string> = new Set(["legal_representative", "parental_authority"]);

/** automatedProcessing of a stored ConsentState snapshot (jsonb), or undefined when unreadable. */
function snapshotProcessingConsent(raw: unknown): unknown {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  return v !== null && typeof v === "object" ? (v as { automatedProcessing?: unknown }).automatedProcessing : undefined;
}

type Step<T> = { ok: true; value: T } | { ok: false; reasonCode: RecheckReason };
const deny = <T>(reasonCode: RecheckReason): Step<T> => ({ ok: false, reasonCode });
const pass = <T>(value: T): Step<T> => ({ ok: true, value });

export class BusinessPreDisclosureRecheck implements PreDisclosureRecheck {
  readonly kind: "local_fixture" | "live";
  private readonly o: BusinessPreDisclosureRecheckOptions;
  private readonly logger: Logger;

  constructor(opts: BusinessPreDisclosureRecheckOptions) {
    this.o = opts;
    this.logger = (opts.logger ?? silentLogger).child({ component: "business_recheck" });
    // A fixture anywhere in the chain makes the whole recheck a fixture (OPS-04 reporting).
    this.kind = opts.accounts.kind === "live" && opts.consent.kind === "live" && opts.relationships.kind === "live" ? "live" : "local_fixture";
  }

  async recheck(ctx: RecheckContext): Promise<RecheckResult> {
    const policyVersion = this.o.policy.policyVersion;
    const outcome = await this.evaluate(ctx);
    if (outcome.allow) {
      this.logger.info("business.recheck.allowed", { workflowId: ctx.workflowId, action: ctx.grantAction ?? null });
      return outcome;
    }
    this.logger.warn("business.recheck.denied", { workflowId: ctx.workflowId, action: ctx.grantAction ?? null, reasonCode: outcome.reasonCode });
    return outcome.policyVersion === undefined ? { ...outcome, policyVersion } : outcome;
  }

  private async evaluate(ctx: RecheckContext): Promise<RecheckResult> {
    // The transition's own transaction is required: every read below is current state inside it.
    const tx = ctx.tx;
    if (!tx) throw new ValidationError("RECHECK_TRANSACTION_REQUIRED");
    const rule = ctx.grantAction !== undefined && Object.hasOwn(RECHECK_RULES, ctx.grantAction) ? RECHECK_RULES[ctx.grantAction] : undefined;
    if (!rule || rule.workflowType !== ctx.workflowType) return { allow: false, reasonCode: "RECHECK_RULE_UNDEFINED" };

    const grant = await this.grant(tx, ctx);
    if (!grant) return { allow: false, reasonCode: "RECHECK_GRANT_NOT_FOUND" };

    const record = await this.recordFor(tx, ctx, rule, grant);
    if (!record.ok) return { allow: false, reasonCode: record.reasonCode };
    if (grant.actor_id === null) return { allow: false, reasonCode: "RECHECK_ACTOR_NOT_ESTABLISHED" };
    const actorId = grant.actor_id;

    const who = rule.scope === "account" ? await this.accountRole(actorId, grant.subject_id) : await this.organizationRole(actorId, grant.subject_id);
    if (!who.ok) return { allow: false, reasonCode: who.reasonCode };

    const account = await this.accountState(rule, actorId, grant.subject_id, who.value.role);
    if (!account.ok) return { allow: false, reasonCode: account.reasonCode };

    const consentRef = rule.scope === "account" ? grant.subject_id : actorId;
    const consent = await this.consentFor(tx, ctx, consentRef);
    if (!consent.ok) return { allow: false, reasonCode: consent.reasonCode };

    const switches = snapshotFromEngaged((await tx.query<{ scope: string; target: string }>("select scope, target from kill_switches where engaged order by scope, target")).rows);
    if (ctx.guard === "material_change" && switches.writes) return { allow: false, reasonCode: "KILL_SWITCH_WRITES" };

    const relationships: RelationshipFact[] = [];
    for (const f of await this.o.relationships.relationshipsFor(actorId, who.value.role)) {
      const parsed = RelationshipFact.safeParse(f);
      if (parsed.success) relationships.push(parsed.data);
    }
    if (who.value.role === "personal_representative" && !relationships.some((f) => REPRESENTATIVE_FACTS.has(f.type) && f.subjectId === grant.subject_id)) {
      return { allow: false, reasonCode: "REPRESENTATION_NOT_ESTABLISHED" };
    }

    const input = PolicyInput.safeParse({
      action: rule.policyAction,
      purpose: "durable_follow_up",
      environment: this.o.environment,
      now: ctx.now,
      tool: null,
      auth: {
        tenantId: ctx.tenantId,
        sessionGeneration: 1,
        actorId,
        selectedRole: who.value.role,
        subjectId: who.value.selfSubjectId,
        organizationId: who.value.organizationId,
        permittedScopes: [],
        // See the module comment: grants naming an account or organization exist only for work accepted at A2.
        assurance: "A2",
        authenticatedAt: isoOf(grant.issued_at),
        expiresAt: isoOf(grant.expires_at),
        revoked: false,
        riskFlags: [],
        // A later disclosure records nothing: call-recording consent does not apply to it.
        consentRecording: "NOT_REQUIRED",
        consentAutomatedProcessing: consent.value,
        stepUpDigest: null,
        stepUpExpiresAt: null,
      },
      resource:
        rule.scope === "account"
          ? {
              type: rule.record === "invoice" ? "invoice" : "support_case",
              tenantId: ctx.tenantId,
              subjectId: grant.subject_id,
              organizationId: null,
              classification: rule.record === "invoice" ? "FINANCIAL" : "PHI",
              actionDigest: null,
            }
          : { type: "support_case", tenantId: ctx.tenantId, subjectId: null, organizationId: grant.subject_id, classification: "INTERNAL", actionDigest: null },
      relationships,
      // AI admission governs new AI calls, not back-office follow-up; every other switch applies.
      killSwitches: { aiAdmission: false, writes: switches.writes, intents: [...switches.intents].sort(), integrations: [...switches.integrations].sort() },
    });
    if (!input.success) throw new ValidationError("RECHECK_POLICY_INPUT_INVALID");
    const decision = await this.o.policy.decide(input.data);
    if (!decision.allow) {
      const reason = decision.reasonCodes[0] ?? "POLICY_DENIED";
      return { allow: false, reasonCode: /^[A-Z][A-Z0-9_]{2,63}$/.test(reason) ? reason : "POLICY_DENIED", policyVersion: decision.policyVersion, decisionId: decision.decisionId };
    }
    return { allow: true, policyVersion: decision.policyVersion, decisionId: decision.decisionId };
  }

  private async grant(tx: Queryable, ctx: RecheckContext): Promise<GrantRow | null> {
    const r = await tx.query<GrantRow>("select subject_id, actor_id, source_ref, issued_at, expires_at from durable_action_grants where grant_id = $1 and tenant_id = $2", [
      ctx.grantRef,
      ctx.tenantId,
    ]);
    return r.rows[0] ?? null;
  }

  /** The authoritative record named by the workflow's source refs, re-read now. */
  private async recordFor(tx: Queryable, ctx: RecheckContext, rule: RecheckRule, grant: GrantRow): Promise<Step<RecordView>> {
    if (rule.record === "invoice") {
      // Billing review source refs: [action id (the grant's source), invoice id, grant ref].
      const refs = ctx.sourceRecordRefs.filter((r) => r !== ctx.grantRef && r !== grant.source_ref);
      if (refs.length !== 1) return deny("RECHECK_RECORD_UNAVAILABLE");
      const invoice = await this.o.billing.getInvoice(refs[0] as string);
      if (!invoice) return deny("RECHECK_RECORD_UNAVAILABLE");
      if (invoice.subjectId !== grant.subject_id) return deny("RECHECK_RECORD_SUBJECT_MISMATCH");
      return pass({ subjectRef: invoice.subjectId, organizationRef: null });
    }
    // Support request the grant was issued for (complaint, partner intake). Restricted records are
    // invisible to the runtime role: they fail closed and a human owns the disclosure.
    if (!ctx.sourceRecordRefs.includes(grant.source_ref)) return deny("RECHECK_RECORD_UNAVAILABLE");
    const r = await tx.query<{ subject_ref: string | null; organization_ref: string | null }>(
      "select subject_ref, organization_ref from support_requests where support_request_id = $1 and tenant_id = $2",
      [grant.source_ref, ctx.tenantId],
    );
    const row = r.rows[0];
    if (!row) return deny("RECHECK_RECORD_UNAVAILABLE");
    if (rule.scope === "account") {
      // An unlinked complaint's grant names the request itself: there is no verified account to disclose to.
      if (row.subject_ref === null) return deny("RECHECK_SUBJECT_NOT_ESTABLISHED");
      if (row.subject_ref !== grant.subject_id) return deny("RECHECK_RECORD_SUBJECT_MISMATCH");
    } else if (row.organization_ref === null || row.organization_ref !== grant.subject_id) {
      return deny("RECHECK_RECORD_SUBJECT_MISMATCH");
    }
    return pass({ subjectRef: row.subject_ref, organizationRef: row.organization_ref });
  }

  /** One role, by fixed precedence, from the authoritative directory (privileges never combined). */
  private async accountRole(actorId: string, subjectId: string): Promise<Step<{ role: Role; selfSubjectId: string | null; organizationId: string | null }>> {
    for (const role of ["client", "provider"] as const) {
      if ((await this.o.directory.selfSubjectId(actorId, role)) === subjectId) {
        return pass({ role, selfSubjectId: subjectId, organizationId: await this.o.directory.organizationFor(actorId, role) });
      }
    }
    // Acting for someone else: only a current legal authority (checked against the registry facts below and by policy).
    return pass({ role: "personal_representative", selfSubjectId: null, organizationId: null });
  }

  private async organizationRole(actorId: string, organizationId: string): Promise<Step<{ role: Role; selfSubjectId: string | null; organizationId: string | null }>> {
    for (const role of ["partner", "payer_representative"] as const) {
      if ((await this.o.directory.organizationFor(actorId, role)) === organizationId) return pass({ role, selfSubjectId: null, organizationId });
    }
    return deny("AFFILIATION_NOT_ESTABLISHED");
  }

  private async accountState(rule: RecheckRule, actorId: string, subjectId: string, role: Role): Promise<Step<null>> {
    const states: (AccountStateValue | null)[] = [];
    if (rule.scope === "account") {
      states.push(await this.o.accounts.forSubject(subjectId));
      if (role === "personal_representative") states.push(await this.o.accounts.forActor(actorId));
    } else {
      states.push(await this.o.accounts.forActor(actorId));
    }
    for (const s of states) {
      if (s === null) return deny("ACCOUNT_STATE_UNKNOWN");
      if (s === "CLOSED") return deny("ACCOUNT_CLOSED");
      if (s === "LOCKED") return deny("ACCOUNT_LOCKED");
      if (s === "RECOVERY_IN_PROGRESS") return deny("ACCOUNT_RECOVERY_IN_PROGRESS");
    }
    return pass(null);
  }

  /** Current registry record first (revocations apply immediately), else the consent captured with the accepted work. */
  private async consentFor(tx: Queryable, ctx: RecheckContext, personRef: string): Promise<Step<ConsentValue>> {
    const current = await this.o.consent.current(ctx.tenantId, personRef);
    if (current) {
      const v = ConsentValue.safeParse(current.automatedProcessing);
      if (!v.success || v.data === "UNKNOWN") return deny("CONSENT_NOT_ESTABLISHED");
      if (v.data === "DECLINED") return deny("CONSENT_REVOKED");
      return pass(v.data);
    }
    const r = await tx.query<{ consent: unknown }>(
      `select r.consent from support_requests r
         join support_request_links l on l.support_request_id = r.support_request_id
        where l.tenant_id = $1 and l.link_kind = 'workflow' and l.link_ref = $2
        order by r.created_at limit 1`,
      [ctx.tenantId, ctx.workflowId],
    );
    const value = ConsentValue.safeParse(snapshotProcessingConsent(r.rows[0]?.consent));
    if (!value.success || value.data === "UNKNOWN") return deny("CONSENT_NOT_ESTABLISHED");
    if (!CONSENT_OK.has(value.data)) return deny("CONSENT_DECLINED");
    return pass(value.data);
  }
}
