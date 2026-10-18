/**
 * Content-free tracing helper (spec section 6, DATA-01).
 *
 * - Span names are code constants (`^[a-z][a-z0-9_.]{2,80}$`).
 * - Span attributes pass an allowlist: each permitted key has a value validator.
 *   Undeclared keys are dropped; values that fail validation are dropped. The
 *   number of discarded attributes is recorded as `vsp.discarded_attributes`.
 * - Session references are bearer handles and are deliberately NOT allowlisted.
 * - Trace baggage is forbidden: the platform never writes baggage, and inbound
 *   baggage (for example propagated from a vendor) is stripped from the context
 *   before any platform span starts, so it cannot be forwarded downstream.
 * - Exceptions are not recorded (stack traces and messages are not content-free);
 *   failed spans carry only the typed reason code.
 */
import { context as otelContext, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import type { AttributeValue, Context, Span, Tracer } from "@opentelemetry/api";
import { PlatformError } from "../shared/errors.js";

const OPAQUE_ID = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
const TURN_ID = /^turn_[A-Za-z0-9_-]{4,64}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const DEPENDENCY = /^[a-z0-9-]{3,64}$/;
const VERSION_LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SPAN_NAME = /^[a-z][a-z0-9_.]{2,80}$/;
const LONG_DIGIT_RUN = /\d{7,}/;

type Validator = (v: unknown) => boolean;
const str = (re: RegExp): Validator => (v) => typeof v === "string" && re.test(v) && !LONG_DIGIT_RUN.test(v.replace(/^[a-z]+_/, ""));
const opaque: Validator = (v) => typeof v === "string" && OPAQUE_ID.test(v);
const oneOf =
  (values: readonly string[]): Validator =>
  (v) =>
    typeof v === "string" && values.includes(v);
const nonNegInt: Validator = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000;
const finiteNonNeg: Validator = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const bool: Validator = (v) => typeof v === "boolean";

/** The only attribute keys a platform span may carry. */
export const SPAN_ATTRIBUTE_ALLOWLIST: Readonly<Record<string, Validator>> = {
  "vsp.tool": str(TOOL_NAME),
  "vsp.tool_version": str(SEMVER),
  "vsp.dependency": str(DEPENDENCY),
  "vsp.status": str(REASON_CODE),
  "vsp.outcome": str(REASON_CODE),
  "vsp.reason_code": str(REASON_CODE),
  "vsp.request_id": opaque,
  "vsp.call_id": opaque,
  "vsp.correlation_id": opaque,
  "vsp.audit_event_id": opaque,
  "vsp.decision_id": opaque,
  "vsp.workflow_id": opaque,
  "vsp.action_id": opaque,
  "vsp.turn_id": (v) => typeof v === "string" && TURN_ID.test(v),
  "vsp.session_generation": nonNegInt,
  "vsp.attempt": nonNegInt,
  "vsp.http_status_code": nonNegInt,
  "vsp.duration_ms": finiteNonNeg,
  "vsp.environment": oneOf(["local", "ci", "sandbox", "staging", "production"]),
  "vsp.admission_class": oneOf(["SAFETY", "HUMAN_ROUTE", "PROTECTED_READ", "WRITE", "PUBLIC", "ANALYTICS"]),
  "vsp.circuit_state": oneOf(["closed", "open", "half_open"]),
  "vsp.policy_version": str(VERSION_LABEL),
  "vsp.local_fixture": bool,
};

export type SpanAttributesInput = Record<string, unknown>;

export interface SanitizedAttributes {
  attributes: Record<string, AttributeValue>;
  discarded: number;
}

export function sanitizeSpanAttributes(input: SpanAttributesInput | undefined): SanitizedAttributes {
  const attributes: Record<string, AttributeValue> = {};
  let discarded = 0;
  for (const [key, value] of Object.entries(input ?? {})) {
    // Own properties only: prototype keys such as "toString" must never match.
    const validate = Object.hasOwn(SPAN_ATTRIBUTE_ALLOWLIST, key) ? SPAN_ATTRIBUTE_ALLOWLIST[key] : undefined;
    if (validate && validate(value)) attributes[key] = value as AttributeValue;
    else discarded += 1;
  }
  return { attributes, discarded };
}

/** Raised when code attempts to write trace baggage. */
export class BaggageWriteForbiddenError extends PlatformError {
  constructor() {
    super("TRACE_BAGGAGE_FORBIDDEN");
  }
}

/**
 * The platform never writes baggage: baggage propagates to every downstream
 * service and vendor, which is exactly where PHI must not travel.
 */
export function setBaggage(): never {
  throw new BaggageWriteForbiddenError();
}

/** Returns `ctx` with any (inbound) baggage removed. */
export function stripBaggage(ctx: Context): Context {
  return propagation.getBaggage(ctx) ? propagation.deleteBaggage(ctx) : ctx;
}

/** Restricted span handle: attribute writes go through the allowlist. */
export interface SafeSpan {
  setAttribute(key: string, value: unknown): void;
  /** Event names are code constants; event attributes pass the same allowlist. */
  addEvent(name: string, attributes?: SpanAttributesInput): void;
}

export interface SafeTracer {
  withSpan<T>(name: string, attributes: SpanAttributesInput, fn: (span: SafeSpan) => Promise<T>): Promise<T>;
}

function wrap(span: Span): SafeSpan {
  let discarded = 0;
  return {
    setAttribute(key, value) {
      const s = sanitizeSpanAttributes({ [key]: value });
      if (s.discarded > 0) {
        discarded += s.discarded;
        span.setAttribute("vsp.discarded_attributes", discarded);
        return;
      }
      const v = s.attributes[key];
      if (v !== undefined) span.setAttribute(key, v);
    },
    addEvent(name, attributes) {
      const s = sanitizeSpanAttributes(attributes);
      span.addEvent(SPAN_NAME.test(name) ? name : "invalid_event_name", s.attributes);
    },
  };
}

const reasonCodeOf = (err: unknown): string =>
  err instanceof PlatformError && REASON_CODE.test(err.reasonCode) ? err.reasonCode : "UNCLASSIFIED_ERROR";

/**
 * Creates a tracer whose spans can only carry allowlisted attributes and never
 * baggage. Defaults to the global `@opentelemetry/api` tracer (a no-op until an
 * SDK is registered; SDK/exporter setup is outside this module).
 */
export function createSafeTracer(tracer: Tracer = trace.getTracer("vsp-platform")): SafeTracer {
  return {
    async withSpan<T>(name: string, attributes: SpanAttributesInput, fn: (span: SafeSpan) => Promise<T>): Promise<T> {
      const parent = stripBaggage(otelContext.active());
      const { attributes: attrs, discarded } = sanitizeSpanAttributes(attributes);
      if (discarded > 0) attrs["vsp.discarded_attributes"] = discarded;
      const span = tracer.startSpan(SPAN_NAME.test(name) ? name : "invalid_span_name", { attributes: attrs }, parent);
      try {
        const result = await otelContext.with(trace.setSpan(parent, span), () => fn(wrap(span)));
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        const code = reasonCodeOf(err);
        span.setAttribute("vsp.reason_code", code);
        span.setStatus({ code: SpanStatusCode.ERROR, message: code });
        throw err;
      } finally {
        span.end();
      }
    },
  };
}
