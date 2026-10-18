/**
 * Internal summary templates for support requests (spec section 8: "store a concise
 * approved summary ... instead of" a transcript). These are staff-facing record
 * summaries, not caller-facing speech. Slots accept codes only (UPPER_SNAKE or a
 * lower-case enum token without digit runs): caller words, model text and opaque
 * record ids never enter a summary (ids live in support_request_links).
 *
 * The wording is an engineering DRAFT pending support operations review.
 */
import { ValidationError } from "../../shared/errors.js";

export interface SummaryTemplate {
  text: string;
  slots: readonly string[];
}

export const SUMMARY_TEMPLATES: Readonly<Record<string, SummaryTemplate>> = Object.freeze({
  "summary.general_intake": { text: "Support request recorded by the voice assistant. Category: {issueCategory}. Linked to a verified account: {linked}.", slots: ["issueCategory", "linked"] },
  "summary.billing_review": {
    text: "Billing review submitted by the client. Reason category: {reasonCategory}. Invoice marked IN_REVIEW; the decision is pending a billing specialist. No refund, waiver or adjustment was promised.",
    slots: ["reasonCategory"],
  },
  "summary.partner_intake": { text: "Organization-scoped partner intake. Request type: {requestType}. Urgency: {urgency}. No individual records were requested or disclosed.", slots: ["requestType", "urgency"] },
  "summary.complaint": { text: "Complaint recorded by the voice assistant. Category: {category}. Callback requested: {callback}.", slots: ["category", "callback"] },
  "summary.human_handoff": { text: "Caller asked for a person. Transfer reason: {reason}. Category: {issueCategory}.", slots: ["reason", "issueCategory"] },
  "summary.safety_route": { text: "Priority safety routing initiated. Signal source: {signalSource}. Restricted record; details are held by the safety owner queue.", slots: ["signalSource"] },
});

const SLOT_VALUE = /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_]{1,63})$/;

/** Assembles a summary; unknown templates, missing/extra slots or non-code values fail closed. */
export function assembleSummary(templateId: string, slots: Record<string, string>): string {
  const t = SUMMARY_TEMPLATES[templateId];
  if (!t) throw new ValidationError("SUMMARY_TEMPLATE_UNKNOWN");
  const keys = Object.keys(slots).sort();
  if (keys.length !== t.slots.length || [...t.slots].sort().some((k, i) => k !== keys[i])) throw new ValidationError("SUMMARY_SLOTS_INVALID");
  let text = t.text;
  for (const k of t.slots) {
    const v = slots[k];
    if (typeof v !== "string" || !SLOT_VALUE.test(v) || /\d{4,}/.test(v)) throw new ValidationError("SUMMARY_SLOT_VALUE_INVALID");
    text = text.replace(`{${k}}`, v);
  }
  if (text.length > 600 || /[{}]/.test(text)) throw new ValidationError("SUMMARY_RENDER_INVALID");
  return text;
}
