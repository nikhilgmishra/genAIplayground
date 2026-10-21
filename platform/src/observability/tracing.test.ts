import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { context, propagation, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Context, ContextManager, Span, SpanContext, SpanOptions, SpanStatus, Tracer } from "@opentelemetry/api";
import { BaggageWriteForbiddenError, SPAN_EVENT_NAMES, SPAN_NAMES, createSafeTracer, sanitizeSpanAttributes, setBaggage, spanEventNameOf, spanNameOf, stripBaggage } from "./tracing.js";
import { DependencyError } from "../shared/errors.js";
import { newId, newTurnId } from "../shared/ids.js";
import { CALLS, PEOPLE } from "../fixtures/synthetic-world.js";

/** LOCAL TEST FIXTURE: AsyncLocalStorage context manager so context.with() is observable. */
class FixtureContextManager implements ContextManager {
  private readonly als = new AsyncLocalStorage<Context>();
  active(): Context {
    return this.als.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(ctx: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A): ReturnType<F> {
    return this.als.run(ctx, () => fn.apply(thisArg, args));
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    return this;
  }
}

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status: SpanStatus | null;
  ended: boolean;
  events: { name: string; attributes: unknown }[];
  parentHadBaggage: boolean;
  exceptionsRecorded: number;
}

/** LOCAL TEST FIXTURE tracer recording what would be exported. */
function fixtureTracer() {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    startSpan(name: string, options?: SpanOptions, ctx?: Context): Span {
      const rec: RecordedSpan = {
        name,
        attributes: { ...(options?.attributes ?? {}) },
        status: null,
        ended: false,
        events: [],
        parentHadBaggage: ctx ? propagation.getBaggage(ctx) !== undefined : false,
        exceptionsRecorded: 0,
      };
      spans.push(rec);
      const span: Span = {
        spanContext: (): SpanContext => ({ traceId: "0".repeat(31) + "1", spanId: "0".repeat(15) + "1", traceFlags: 1 }),
        setAttribute(k, v) {
          rec.attributes[k] = v;
          return span;
        },
        setAttributes(a) {
          Object.assign(rec.attributes, a);
          return span;
        },
        addEvent(n, a) {
          rec.events.push({ name: n, attributes: a });
          return span;
        },
        addLink: () => span,
        addLinks: () => span,
        setStatus(s) {
          rec.status = s;
          return span;
        },
        updateName: () => span,
        end() {
          rec.ended = true;
        },
        isRecording: () => true,
        recordException() {
          rec.exceptionsRecorded += 1;
        },
      };
      return span;
    },
    startActiveSpan: (() => {
      throw new Error("not used");
    }) as Tracer["startActiveSpan"],
  };
  return { tracer, spans };
}

const manager = new FixtureContextManager();
beforeAll(() => {
  context.setGlobalContextManager(manager);
});
afterAll(() => {
  context.disable();
});

describe("safe tracing helper", () => {
  it("[DATA-01] drops non-allowlisted attributes and PHI-shaped values", () => {
    const callId = newId("cal");
    const s = sanitizeSpanAttributes({
      "vsp.tool": "get_invoice_status",
      "vsp.call_id": callId,
      "vsp.reason_code": "SESSION_EXPIRED",
      "caller.name": PEOPLE.avery.fullName,
      "vsp.dependency": CALLS.primary.callerIdE164,
      "vsp.session_ref": "ses_abcdefghijklmnopqrstuvwxyz012345",
      "vsp.status": "my date of birth is 1990-01-01",
    });
    expect(s.attributes).toEqual({
      "vsp.tool": "get_invoice_status",
      "vsp.call_id": callId,
      "vsp.reason_code": "SESSION_EXPIRED",
    });
    expect(s.discarded).toBe(4);
  });

  it("[DATA-01][FO-03-30] adversarial: id attributes accept only the platform's generated id grammar (own prefix, exactly the generated body, no 7-digit run); reason codes only the closed upper-snake grammar without a 5-digit run", () => {
    // The verifier's probe values (u1-span-opaque): content shaped like an opaque id or a reason code.
    const probes: Record<string, string> = {
      "vsp.call_id": "cal_JaneDoe_DOB_19800101",
      "vsp.request_id": "req_ssn123456789phone5550142",
      "vsp.action_id": "act_MarySmithMRN00012345678",
      "vsp.tool": "lookup_5550142123",
    };
    const s = sanitizeSpanAttributes(probes);
    expect(s.attributes).toEqual({});
    expect(s.discarded).toBe(4);
    // Every id key keeps a generated id of its own prefixes and drops: another prefix, a fixture-shaped id (wrong
    // body length), a body of the right length with a 7-digit run, and a non-string.
    const ids: Record<string, readonly string[]> = {
      "vsp.request_id": ["req"],
      "vsp.call_id": ["cal", "call"],
      "vsp.correlation_id": ["cor"],
      "vsp.audit_event_id": ["aud"],
      "vsp.decision_id": ["dec"],
      "vsp.workflow_id": ["wf"],
      "vsp.action_id": ["act"],
    };
    for (const [key, prefixes] of Object.entries(ids)) {
      for (const prefix of prefixes) {
        const id = newId(prefix);
        expect(sanitizeSpanAttributes({ [key]: id }).attributes, key).toEqual({ [key]: id });
        expect(sanitizeSpanAttributes({ [key]: `${prefix}_synthFixtureShaped01` }).discarded, `${key} short body`).toBe(1);
        expect(sanitizeSpanAttributes({ [key]: `${prefix}_${"A".repeat(25)}` }).discarded, `${key} long body`).toBe(1);
        expect(sanitizeSpanAttributes({ [key]: `${prefix}_ssn1234567abcdefghijklmn` }).discarded, `${key} digit run`).toBe(1);
      }
      expect(sanitizeSpanAttributes({ [key]: newId("zzz") }).discarded, `${key} foreign prefix`).toBe(1);
      expect(sanitizeSpanAttributes({ [key]: 12345 }).discarded, `${key} non-string`).toBe(1);
    }
    // A fixture call id of the regression world is not a generated id: it is dropped, never exported.
    expect(sanitizeSpanAttributes({ "vsp.call_id": CALLS.primary.callId }).discarded).toBe(1);
    // Turn ids: newTurnId only (12 characters).
    const turn = newTurnId();
    expect(sanitizeSpanAttributes({ "vsp.turn_id": turn }).attributes).toEqual({ "vsp.turn_id": turn });
    for (const bad of ["turn_JaneDoe", "turn_AbCdEfGhIjKlMn", "turn_1234567890ab"]) expect(sanitizeSpanAttributes({ "vsp.turn_id": bad }).discarded, bad).toBe(1);
    // Reason codes: the closed grammar keeps code constants and drops dates, phone and record numbers and malformed codes.
    for (const key of ["vsp.reason_code", "vsp.status", "vsp.outcome"]) {
      for (const ok of ["SESSION_EXPIRED", "HTTP_429", "ECDSA_P256_SHA256", "TIMEOUT"]) expect(sanitizeSpanAttributes({ [key]: ok }).attributes, `${key} ${ok}`).toEqual({ [key]: ok });
      for (const bad of ["DOB_19800101", "CALLBACK_5550142", "MRN00012345", "SESSION__EXPIRED", "SESSION_EXPIRED_", "session_expired", "AB", "A".repeat(65), "A_B_C_D_E_F_G_H_I_J_K"]) {
        expect(sanitizeSpanAttributes({ [key]: bad }).discarded, `${key} ${bad}`).toBe(1);
      }
    }
  });

  it("[DATA-01] prototype keys such as toString or __proto__ are not treated as allowlisted", () => {
    const s = sanitizeSpanAttributes({ toString: PEOPLE.avery.fullName, constructor: "x", hasOwnProperty: CALLS.primary.callerIdE164 });
    expect(s.attributes).toEqual({});
    expect(s.discarded).toBe(3);
  });

  it("[DATA-01] spans carry only sanitized attributes and record the reason code, not the exception", async () => {
    const { tracer, spans } = fixtureTracer();
    const safe = createSafeTracer(tracer);
    await expect(
      safe.withSpan("dependency.call", { "vsp.dependency": "salesforce", note: PEOPLE.blake.fullName }, async (span) => {
        span.setAttribute("vsp.attempt", 2);
        span.setAttribute("caller.phone", CALLS.primary.callerIdE164);
        span.addEvent("dependency.retry", { "vsp.attempt": 2, dob: PEOPLE.blake.dateOfBirth });
        throw new DependencyError("TIMEOUT", "UNKNOWN");
      }),
    ).rejects.toThrow("TIMEOUT");
    const rec = spans[0];
    expect(rec?.attributes).toEqual({ "vsp.dependency": "salesforce", "vsp.discarded_attributes": 1, "vsp.attempt": 2, "vsp.reason_code": "TIMEOUT" });
    expect(rec?.status).toEqual({ code: SpanStatusCode.ERROR, message: "TIMEOUT" });
    expect(rec?.exceptionsRecorded).toBe(0);
    expect(rec?.ended).toBe(true);
    expect(JSON.stringify(rec)).not.toContain(PEOPLE.blake.fullName);
    expect(JSON.stringify(rec)).not.toContain(CALLS.primary.callerIdE164);
  });

  it("[DATA-01] baggage writes are forbidden", () => {
    expect(() => setBaggage()).toThrow(BaggageWriteForbiddenError);
    expect(() => setBaggage()).toThrow("TRACE_BAGGAGE_FORBIDDEN");
  });

  it("[DATA-01] inbound trace baggage is stripped before platform spans start and inside the span body", async () => {
    const { tracer, spans } = fixtureTracer();
    const safe = createSafeTracer(tracer);
    const inbound = propagation.setBaggage(ROOT_CONTEXT, propagation.createBaggage({ "caller.name": { value: PEOPLE.avery.fullName } }));
    expect(propagation.getBaggage(inbound)).toBeDefined();
    expect(propagation.getBaggage(stripBaggage(inbound))).toBeUndefined();
    let baggageInside: unknown = "unset";
    await context.with(inbound, () =>
      safe.withSpan("tool.invoke", { "vsp.tool": "get_invoice_status" }, async () => {
        baggageInside = propagation.getActiveBaggage();
        expect(trace.getActiveSpan()).toBeDefined();
      }),
    );
    expect(baggageInside).toBeUndefined();
    expect(spans[0]?.parentHadBaggage).toBe(false);
    expect(spans[0]?.status?.code).toBe(SpanStatusCode.OK);
  });

  it("[DATA-01] invalid span names are replaced by a constant", async () => {
    const { tracer, spans } = fixtureTracer();
    await createSafeTracer(tracer).withSpan(`lookup ${PEOPLE.avery.fullName}`, {}, async () => 1);
    expect(spans[0]?.name).toBe("invalid_span_name");
  });

  it("[DATA-01][FO-03-30] span and event names come from the closed registries: a well-formed name built from a value is replaced too", async () => {
    const { tracer, spans } = fixtureTracer();
    const shaped = `patient.${PEOPLE.avery.fullName.toLowerCase().replace(/[^a-z]/g, "")}`;
    expect(shaped).toMatch(/^[a-z][a-z0-9_.]{2,80}$/);
    await createSafeTracer(tracer).withSpan(shaped, {}, async (span) => span.addEvent(`caller.${shaped}`));
    expect(spans[0]?.name).toBe("invalid_span_name");
    expect(spans[0]?.events.map((e) => e.name)).toEqual(["invalid_event_name"]);
    expect(spanEventNameOf(`caller.${shaped}`)).toBe("invalid_event_name");
    for (const name of SPAN_NAMES) expect(spanNameOf(name)).toBe(name);
    for (const name of SPAN_EVENT_NAMES) expect(spanEventNameOf(name)).toBe(name);
    expect(JSON.stringify(spans)).not.toContain(shaped);
  });
});
