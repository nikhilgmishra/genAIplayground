/**
 * Builds SpeechDirectives from approved template ids only (spec sections 11, 16).
 * The template's declared version and response class are taken from the registry,
 * and the slot names must match the declaration exactly; anything else fails
 * closed. Rendering, authorization and approval checks happen in the response gate.
 */
import type { SlotValue, SpeechDirective } from "../protocol/index.js";
import type { TemplateRegistry } from "../voice/ports.js";
import { ValidationError } from "../shared/errors.js";

export type ToolSpeech = Omit<SpeechDirective, "turnId" | "sessionGeneration" | "authorizationRef">;

/** Locale whose catalog entry supplies version and class (the registry enforces cross-locale parity). */
export const SOURCE_LOCALE = "en-US";

export function speechFor(templates: TemplateRegistry, templateId: string, slots: Record<string, SlotValue> = {}, sourceRefs: string[] = []): ToolSpeech {
  const t = templates.get(templateId, SOURCE_LOCALE);
  if (!t) throw new ValidationError("SPEECH_TEMPLATE_UNAVAILABLE");
  const declared = Object.keys(t.slots).sort();
  const given = Object.keys(slots).sort();
  if (declared.length !== given.length || declared.some((k, i) => k !== given[i])) throw new ValidationError("SPEECH_TEMPLATE_SLOTS_MISMATCH");
  return { templateId, templateVersion: t.version, responseClass: t.responseClass, slots: { ...slots }, sourceRefs: sourceRefs.slice(0, 16) };
}
