import type { ResponseClass, SlotValue, SpeechDirective } from "../protocol/index.js";

/**
 * Approved response templates and the before-speech gate (spec section 11).
 * Protected classes are rendered only from approved templates with typed,
 * validated slots and a current authorization reference (ACT-05).
 */
export type SlotType =
  | "date"
  | "time"
  | "time_zone"
  | "money_minor_usd"
  | "person_display_name"
  | "support_reference"
  | "enum"
  | "count"
  | "spelled_code"
  | "portal_path"
  /** Two distinct words from the identity module's match-code list (identity/match-code.ts), e.g. "acorn-maple". Not a secret. */
  | "match_code";

export interface TemplateDefinition {
  templateId: string;
  version: string;
  responseClass: ResponseClass;
  locale: string;
  /** Text with {slot} placeholders. */
  text: string;
  slots: Record<string, { type: SlotType; enumValues?: string[] }>;
  approval: { status: "APPROVED" | "PENDING_CLINICAL_APPROVAL" | "PENDING_LEGAL_APPROVAL" | "DRAFT"; approvedBy: string | null };
}

export interface TemplateRegistry {
  get(templateId: string, locale: string): TemplateDefinition | null;
  list(): TemplateDefinition[];
  /** Digest of the template set, pinned as VersionSet.promptTemplates. */
  digest(): string;
}

export interface GateContext {
  sessionRef: string;
  currentTurnId: string;
  sessionGeneration: number;
  /** Policy decisions currently valid for this session/turn. */
  validAuthorizationRefs: ReadonlySet<string>;
  locale: string;
  environment: "local" | "ci" | "sandbox" | "staging" | "production";
}

export type GateResult =
  | { ok: true; utterance: string; templateId: string; responseClass: ResponseClass }
  | { ok: false; reasonCode: string; fallbackUtterance: string; fallbackTemplateId: string };

export interface ResponseGate {
  /** Validates BEFORE the first audible segment; fails closed to a safe explanation + human route. */
  render(directive: SpeechDirective, ctx: GateContext): GateResult;
}

/** Turn and generation tagging so late tool results cannot speak into a different state. */
export interface TurnTracker {
  beginTurn(sessionRef: string, generation: number): string;
  /** Barge-in stops queued speech and invalidates stale segments. Returns invalidated turn id. */
  bargeIn(sessionRef: string): string | null;
  isCurrent(sessionRef: string, turnId: string, generation: number): boolean;
}

export type SlotValues = Record<string, SlotValue>;
