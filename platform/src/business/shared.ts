/**
 * Small helpers shared by the business services and tool modules. Content-free:
 * nothing here formats caller-facing text (only approved templates do that).
 */
import type { AuthContext, ConsentState, PolicyInput } from "../protocol/index.js";
import { ASSURANCE_RANK } from "../protocol/index.js";
import { sessionBindingRefFor } from "../identity/keys.js";
import { newId } from "../shared/ids.js";
import { PlatformError } from "../shared/errors.js";

export type PolicyResource = PolicyInput["resource"];

/**
 * A resource that no relationship fact can ever match (fresh random subject).
 * Used when an authoritative lookup finds nothing, or finds a record bound to
 * another session: policy then denies exactly as it denies another person's
 * record, so an unknown id never yields a "not found" that leaks existence.
 */
export function unresolvableResource(auth: AuthContext, type: string, classification: PolicyResource["classification"], actionDigest: string | null = null): PolicyResource {
  return { type, tenantId: auth.tenantId, subjectId: newId("unr"), organizationId: null, classification, actionDigest };
}

export function subjectResource(
  auth: AuthContext,
  type: string,
  subjectId: string,
  classification: PolicyResource["classification"],
  actionDigest: string | null = null,
): PolicyResource {
  return { type, tenantId: auth.tenantId, subjectId, organizationId: null, classification, actionDigest };
}

export function organizationResource(auth: AuthContext, type: string, organizationId: string, classification: PolicyResource["classification"]): PolicyResource {
  return { type, tenantId: auth.tenantId, subjectId: null, organizationId, classification, actionDigest: null };
}

export function openResource(auth: AuthContext, type: string, classification: PolicyResource["classification"]): PolicyResource {
  return { type, tenantId: auth.tenantId, subjectId: null, organizationId: null, classification, actionDigest: null };
}

export const atLeast = (have: AuthContext["assurance"], need: AuthContext["assurance"]): boolean => ASSURANCE_RANK[have] >= ASSURANCE_RANK[need];

/** Non-bearer session binding reference for audit evidence (never the bearer session ref). */
export const auditSessionRef = (auth: AuthContext | null): string | null => {
  if (!auth) return null;
  try {
    return sessionBindingRefFor(auth.sessionRef);
  } catch {
    return null;
  }
};

/** Salesforce consent status code derived from the server-established consent state. */
export const consentStatusCode = (c: ConsentState): string => `REC_${c.recording}_PROC_${c.automatedProcessing}`;

export const UNKNOWN_CONSENT: ConsentState = {
  recording: "UNKNOWN",
  automatedProcessing: "UNKNOWN",
  disclosureTemplateVersion: null,
  capturedAt: null,
  capturedBy: "none",
};

/** Reason code of a thrown error (never its message or any value). */
export const reasonOf = (err: unknown, fallback = "UNEXPECTED_ERROR"): string =>
  err instanceof PlatformError && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) ? err.reasonCode : fallback;

/** Local calendar date (YYYY-MM-DD) and 24h time (HH:MM) of a UTC instant in an IANA time zone. */
export function localDateTime(isoInstant: string, timeZone: string): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(isoInstant)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** UTC calendar date of an instant, shifted by whole days. */
export function utcDate(d: Date, plusDays = 0): string {
  return new Date(d.getTime() + plusDays * 86_400_000).toISOString().slice(0, 10);
}

/** ISO-8601 duration (P..D/W/H/M subset used by contracts) to milliseconds. */
export function durationMs(iso: string): number {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso);
  if (!m) throw new Error("DURATION_INVALID");
  const [, w, d, h, min] = m;
  return (((Number(w ?? 0) * 7 + Number(d ?? 0)) * 24 + Number(h ?? 0)) * 60 + Number(min ?? 0)) * 60_000;
}

export const upperCode = (v: string): string => v.toUpperCase();
