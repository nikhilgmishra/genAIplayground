import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { context, propagation, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Context, ContextManager, Span, SpanContext, SpanOptions, SpanStatus, Tracer } from "@opentelemetry/api";
import { BaggageWriteForbiddenError, createSafeTracer, sanitizeSpanAttributes, setBaggage, stripBaggage } from "./tracing.js";
import { DependencyError } from "../shared/errors.js";
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
    const s = sanitizeSpanAttributes({
      "vsp.tool": "get_invoice_status",
      "vsp.call_id": CALLS.primary.callId,
      "vsp.reason_code": "SESSION_EXPIRED",
      "caller.name": PEOPLE.avery.fullName,
      "vsp.dependency": CALLS.primary.callerIdE164,
      "vsp.session_ref": "ses_abcdefghijklmnopqrstuvwxyz012345",
      "vsp.status": "my date of birth is 1990-01-01",
    });
    expect(s.attributes).toEqual({
      "vsp.tool": "get_invoice_status",
      "vsp.call_id": CALLS.primary.callId,
      "vsp.reason_code": "SESSION_EXPIRED",
    });
    expect(s.discarded).toBe(4);
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
});
