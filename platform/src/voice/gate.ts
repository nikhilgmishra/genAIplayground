/**
 * Before-speech response gate (spec section 11; ACT-05, SAFE-02, DATA-01).
 *
 * Every caller-facing utterance is rendered here from an approved template
 * BEFORE its first audible segment. Checks, in order (fail closed):
 *   1. strict SpeechDirective and GateContext parsing;
 *   2. session generation and turn id must be current (STALE_GENERATION /
 *      STALE_TURN): a late tool result cannot speak into a different state;
 *   3. template exists for the locale; version and response class match;
 *   4. approval: only effectively APPROVED templates render outside local/ci;
 *      in local/ci PENDING/DRAFT templates render with `localUnapprovedBadge`;
 *   5. protected classes need a current authorizationRef (IDENTITY,
 *      FINANCIAL_FACT, COMMITMENT, PROTECTED_FACT). SAFETY, CLINICAL_BOUNDARY
 *      and RECORDING_DISCLOSURE are exempt because they must work at A0 for an
 *      unverified caller (SAFE-02) and disclose no account data;
 *   6. FINANCIAL_FACT, PROTECTED_FACT and COMMITMENT must cite sources;
 *   7. slots: no missing or extra slots; each value validated by type;
 *   8. rendered output post-check (no braces, no control characters, length
 *      bound, no prohibited clinical content).
 * Any failure returns the safe fallback (explanation + human route), except
 * stale turns/generations, which are dropped silently: they belong to a state
 * the caller has already left.
 *
 * LOW_RISK_GROUNDED free paraphrase is NOT implemented: model-generated text
 * is BLOCKED pending approved output checks; only templates render here.
 * A successful result is frozen and registered so the speech queue can refuse
 * anything that did not come from this gate.
 */
import { z } from "zod";
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { Environment, SpeechDirective } from "../protocol/index.js";
import type { ResponseClass, SlotValue } from "../protocol/index.js";
import type { GateContext, ResponseGate, TurnTracker } from "./ports.js";
import { containsProhibitedClinicalContent, hasControlCharacters } from "./registry.js";
import type { CatalogTemplate, CatalogTemplateRegistry } from "./registry.js";
import { renderSlotValue, validateSlotValue } from "./slots.js";
import type { SlotLanguage } from "./slots.js";

export const PROTECTED_RESPONSE_CLASSES: ReadonlySet<ResponseClass> = new Set<ResponseClass>([
  "IDENTITY",
  "FINANCIAL_FACT",
  "COMMITMENT",
  "CLINICAL_BOUNDARY",
  "RECORDING_DISCLOSURE",
  "SAFETY",
  "PROTECTED_FACT",
]);
/** Protected classes that must render at A0 without an authorization reference. */
export const AUTHORIZATION_EXEMPT_CLASSES: ReadonlySet<ResponseClass> = new Set<ResponseClass>(["SAFETY", "CLINICAL_BOUNDARY", "RECORDING_DISCLOSURE"]);
/** Classes whose response record must cite sources / action receipts. */
export const SOURCE_REQUIRED_CLASSES: ReadonlySet<ResponseClass> = new Set<ResponseClass>(["FINANCIAL_FACT", "PROTECTED_FACT", "COMMITMENT"]);
/** Environments where unapproved (PENDING/DRAFT) templates may render, always flagged. */
export const UNAPPROVED_TEMPLATES_ALLOWED_IN: ReadonlySet<string> = new Set(["local", "ci"]);
export const FALLBACK_TEMPLATE_ID = "fallback.safe_explanation";
export const DEFAULT_FALLBACK_LOCALE = "en-US";
export const MAX_UTTERANCE_CHARS = 500;
export const LOCAL_UNAPPROVED_BADGE = "LOCAL — UNAPPROVED TEMPLATE (DRAFT/PENDING)";

/** Content-free record of what was rendered and why it was allowed. */
export interface ResponseRecord {
  templateId: string;
  templateVersion: string;
  responseClass: ResponseClass;
  locale: string;
  approvalStatus: string;
  authorizationRef: string | null;
  sourceRefs: readonly string[];
  turnId: string;
  sessionGeneration: number;
  catalogDigest: string;
  environment: string;
}

/** Success result; `implements ResponseGate` checks it remains a valid GateResult. */
export interface GatedUtterance {
  readonly ok: true;
  readonly utterance: string;
  readonly templateId: string;
  readonly responseClass: ResponseClass;
  readonly templateVersion: string;
  readonly locale: string;
  readonly sessionRef: string;
  readonly turnId: string;
  readonly sessionGeneration: number;
  readonly protectedClass: boolean;
  /** "Let me check that."-style acknowledgment; never resolution. */
  readonly acknowledgmentOnly: boolean;
  /** Shown in local demos for every unapproved template that rendered. */
  readonly localUnapprovedBadge: boolean;
  readonly record: ResponseRecord;
}

export type GateDisposition = "SPEAK_FALLBACK_AND_ROUTE_HUMAN" | "ROUTE_HUMAN_WITHOUT_SPEECH" | "DROP_STALE";

export interface GateRejection {
  readonly ok: false;
  readonly reasonCode: string;
  /** Empty unless disposition is SPEAK_FALLBACK_AND_ROUTE_HUMAN. */
  readonly fallbackUtterance: string;
  readonly fallbackTemplateId: string;
  readonly disposition: GateDisposition;
  readonly routeToHuman: boolean;
  readonly localUnapprovedBadge: boolean;
  /** Current turn the fallback belongs to (null when the context itself is invalid). */
  readonly sessionRef: string | null;
  readonly turnId: string | null;
  readonly sessionGeneration: number | null;
  readonly locale: string | null;
}

const ISSUED = new WeakSet<object>();

/** True only for results produced by a TemplateResponseGate in this process (unforgeable). */
export function isGateApproved(value: unknown): value is GatedUtterance {
  return typeof value === "object" && value !== null && ISSUED.has(value) && (value as { ok?: unknown }).ok === true;
}

/** True only for gate-issued rejections whose fallback may be spoken. */
export function isGateFallback(value: unknown): value is GateRejection {
  return (
    typeof value === "object" &&
    value !== null &&
    ISSUED.has(value) &&
    (value as { ok?: unknown }).ok === false &&
    (value as { disposition?: unknown }).disposition === "SPEAK_FALLBACK_AND_ROUTE_HUMAN"
  );
}

const GateContextSchema = z.strictObject({
  sessionRef: z.string().min(8).max(128),
  currentTurnId: z.string().regex(/^turn_[A-Za-z0-9_-]{4,64}$/),
  sessionGeneration: z.number().int().min(1),
  validAuthorizationRefs: z.instanceof(Set),
  locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
  environment: Environment,
});

export interface TemplateResponseGateOptions {
  registry: CatalogTemplateRegistry;
  /** Optional second check that the turn is still current in the turn tracker. */
  turnTracker?: TurnTracker;
  logger?: Logger;
}

export class TemplateResponseGate implements ResponseGate {
  private readonly registry: CatalogTemplateRegistry;
  private readonly turns: TurnTracker | null;
  private readonly logger: Logger;

  constructor(opts: TemplateResponseGateOptions) {
    this.registry = opts.registry;
    this.turns = opts.turnTracker ?? null;
    this.logger = (opts.logger ?? silentLogger).child({ component: "voice_gate" });
  }

  render(directive: SpeechDirective | unknown, ctx: GateContext): GatedUtterance | GateRejection {
    const c = GateContextSchema.safeParse(ctx);
    if (!c.success) return this.reject("GATE_CONTEXT_INVALID", null, "ROUTE_HUMAN_WITHOUT_SPEECH");
    const context = c.data as GateContext;
    const d = SpeechDirective.safeParse(directive);
    if (!d.success) return this.reject("DIRECTIVE_INVALID", context);
    const dir = d.data;

    if (dir.sessionGeneration !== context.sessionGeneration) return this.reject("STALE_GENERATION", context, "DROP_STALE", dir);
    if (dir.turnId !== context.currentTurnId) return this.reject("STALE_TURN", context, "DROP_STALE", dir);
    if (this.turns && !this.turns.isCurrent(context.sessionRef, dir.turnId, dir.sessionGeneration)) return this.reject("STALE_TURN", context, "DROP_STALE", dir);

    const template = this.registry.get(dir.templateId, context.locale);
    if (!template) return this.reject("TEMPLATE_NOT_FOUND", context, undefined, dir);
    if (template.version !== dir.templateVersion) return this.reject("TEMPLATE_VERSION_MISMATCH", context, undefined, dir);
    if (template.responseClass !== dir.responseClass) return this.reject("RESPONSE_CLASS_MISMATCH", context, undefined, dir);

    const approval = this.registry.effectiveApproval(template);
    const permissive = UNAPPROVED_TEMPLATES_ALLOWED_IN.has(context.environment);
    if (approval !== "APPROVED" && !permissive) return this.reject("TEMPLATE_NOT_APPROVED", context, undefined, dir);

    const protectedClass = PROTECTED_RESPONSE_CLASSES.has(template.responseClass);
    if (protectedClass && !AUTHORIZATION_EXEMPT_CLASSES.has(template.responseClass)) {
      if (dir.authorizationRef === null) return this.reject("AUTHORIZATION_MISSING", context, undefined, dir);
      if (!context.validAuthorizationRefs.has(dir.authorizationRef)) return this.reject("AUTHORIZATION_NOT_CURRENT", context, undefined, dir);
    }
    if (SOURCE_REQUIRED_CLASSES.has(template.responseClass) && dir.sourceRefs.length === 0) return this.reject("SOURCE_REFERENCE_MISSING", context, undefined, dir);

    const rendered = this.renderTemplate(template, dir.slots);
    if (!rendered.ok) return this.reject(rendered.reasonCode, context, undefined, dir);
    const post = postCheck(rendered.text);
    if (post) return this.reject(post, context, undefined, dir);

    const result: GatedUtterance = Object.freeze({
      ok: true as const,
      utterance: rendered.text,
      templateId: template.templateId,
      responseClass: template.responseClass,
      templateVersion: template.version,
      locale: context.locale,
      sessionRef: context.sessionRef,
      turnId: dir.turnId,
      sessionGeneration: dir.sessionGeneration,
      protectedClass,
      acknowledgmentOnly: template.metadata.acknowledgmentOnly,
      localUnapprovedBadge: approval !== "APPROVED",
      record: Object.freeze({
        templateId: template.templateId,
        templateVersion: template.version,
        responseClass: template.responseClass,
        locale: context.locale,
        approvalStatus: approval,
        authorizationRef: dir.authorizationRef,
        sourceRefs: Object.freeze([...dir.sourceRefs]),
        turnId: dir.turnId,
        sessionGeneration: dir.sessionGeneration,
        catalogDigest: this.registry.digest(),
        environment: context.environment,
      }),
    });
    ISSUED.add(result);
    return result;
  }

  private renderTemplate(template: CatalogTemplate, slots: Record<string, SlotValue>): { ok: true; text: string } | { ok: false; reasonCode: string } {
    const declared = Object.keys(template.slots);
    for (const name of Object.keys(slots)) if (!Object.hasOwn(template.slots, name)) return { ok: false, reasonCode: "SLOT_UNEXPECTED" };
    const lang: SlotLanguage = template.locale.startsWith("es") ? "es" : "en";
    const values: Record<string, string> = {};
    for (const name of declared) {
      const spec = template.slots[name];
      if (!spec) return { ok: false, reasonCode: "SLOT_SPEC_MISSING" };
      const value = Object.hasOwn(slots, name) ? slots[name] : undefined;
      const check = validateSlotValue(spec, value);
      if (!check.ok) return { ok: false, reasonCode: check.reasonCode };
      values[name] = renderSlotValue(spec, value as SlotValue, lang);
    }
    const text = template.text.replace(/\{([a-z][a-zA-Z0-9]{0,40})\}/g, (m, name: string) => (Object.hasOwn(values, name) ? (values[name] ?? m) : m));
    return { ok: true, text };
  }

  private reject(
    reasonCode: string,
    ctx: GateContext | null,
    disposition: GateDisposition = "SPEAK_FALLBACK_AND_ROUTE_HUMAN",
    dir?: { templateId: string; responseClass: ResponseClass },
  ): GateRejection {
    this.logger.warn("voice.gate.rejected", { reasonCode, template: dir?.templateId ?? null, kind: dir?.responseClass ?? null });
    let finalDisposition = disposition;
    let utterance = "";
    let badge = false;
    if (ctx && disposition === "SPEAK_FALLBACK_AND_ROUTE_HUMAN") {
      const fb = this.registry.get(FALLBACK_TEMPLATE_ID, ctx.locale) ?? this.registry.get(FALLBACK_TEMPLATE_ID, DEFAULT_FALLBACK_LOCALE);
      const approval = fb ? this.registry.effectiveApproval(fb) : null;
      const speakable =
        fb !== null && Object.keys(fb.slots).length === 0 && (approval === "APPROVED" || UNAPPROVED_TEMPLATES_ALLOWED_IN.has(ctx.environment)) && postCheck(fb.text) === null;
      if (speakable && fb) {
        utterance = fb.text;
        badge = approval !== "APPROVED";
      } else {
        // No approved fallback: the human route still happens (independent Studio route), without speech.
        finalDisposition = "ROUTE_HUMAN_WITHOUT_SPEECH";
      }
    }
    const result: GateRejection = Object.freeze({
      ok: false as const,
      reasonCode,
      fallbackUtterance: utterance,
      fallbackTemplateId: FALLBACK_TEMPLATE_ID,
      disposition: finalDisposition,
      routeToHuman: finalDisposition !== "DROP_STALE",
      localUnapprovedBadge: badge,
      sessionRef: ctx?.sessionRef ?? null,
      turnId: ctx?.currentTurnId ?? null,
      sessionGeneration: ctx?.sessionGeneration ?? null,
      locale: ctx?.locale ?? null,
    });
    ISSUED.add(result);
    return result;
  }
}

/** Output checks on the final text; returns a reason code or null. */
export function postCheck(text: string): string | null {
  if (text.length === 0) return "OUTPUT_EMPTY";
  if (text.length > MAX_UTTERANCE_CHARS) return "OUTPUT_TOO_LONG";
  if (/[{}]/.test(text)) return "OUTPUT_UNRESOLVED_PLACEHOLDER";
  if (hasControlCharacters(text)) return "OUTPUT_CONTROL_CHARACTERS";
  if (/\b(undefined|null|NaN)\b|\[object /.test(text)) return "OUTPUT_RENDER_ARTIFACT";
  if (containsProhibitedClinicalContent(text)) return "OUTPUT_CLINICAL_CONTENT_PROHIBITED";
  return null;
}
