/**
 * The model exchange over the egress-classified transport (WP-08; FO-09-45, FO-09-09, DATA-01): failure mapping by
 * transport phase, Retry-After parsing, and the incremental stream watchdog (first event and idle deadlines, which
 * close the exchange). The watchdog test feeds a synthetic chunk source (a UNIT FAKE body, not an emulator).
 */
import { describe, expect, it } from "vitest";
import { TransportError } from "../../connectors/http/transport.js";
import { AccessDeniedError, DependencyError } from "../../shared/errors.js";
import { ModelCallError } from "../port/errors.js";
import { retryAfterFrom, transportFailureToModelError, watched } from "./http-exchange.js";

describe("model exchange failure mapping [FO-09-09][FO-09-45]", () => {
  it("[FO-09-09] every transport phase maps to a typed failure with its error class", () => {
    const m = (e: unknown) => {
      const x = transportFailureToModelError(e);
      return { kind: x.kind, reasonCode: x.reasonCode, errorClass: x.errorClass, outcome: x.outcome, phase: x.timeoutPhase };
    };
    expect(m(new TransportError("TIMEOUT_BEFORE_SEND", "NOT_STARTED", true, "CONNECT", false))).toMatchObject({ kind: "TIMED_OUT", errorClass: "RETRYABLE", outcome: "NOT_STARTED", phase: "BEFORE_SEND" });
    expect(m(new TransportError("READ_TIMEOUT", "FAILED", true, "SENT", true))).toMatchObject({ kind: "TIMED_OUT", reasonCode: "MODEL_READ_TIMEOUT", phase: "FIRST_EVENT", outcome: "FAILED" });
    expect(m(new TransportError("READ_TIMEOUT", "FAILED", true, "RESPONSE", true))).toMatchObject({ kind: "TIMED_OUT", phase: "STREAM_IDLE" });
    expect(m(new TransportError("CALLER_ABORTED", "FAILED", false, "RESPONSE", true))).toMatchObject({ kind: "CANCELLED", reasonCode: "MODEL_CALL_CANCELLED" });
    expect(m(new TransportError("CONNECTION_REFUSED", "NOT_STARTED", true, "CONNECT", false))).toMatchObject({ kind: "FAILED", errorClass: "RETRYABLE", outcome: "NOT_STARTED" });
    expect(m(new TransportError("CONNECTION_LOST", "FAILED", true, "RESPONSE", true))).toMatchObject({ kind: "FAILED", errorClass: "RETRYABLE" });
    expect(m(new TransportError("CONNECTOR_TLS_FAILED", "NOT_STARTED", false, "TLS", false))).toMatchObject({ kind: "FAILED", errorClass: "PERMANENT" });
    expect(m(new TransportError("CONNECTOR_RESPONSE_TOO_LARGE", "FAILED", false, "RESPONSE", true))).toMatchObject({ kind: "MALFORMED", reasonCode: "MODEL_RESPONSE_TOO_LARGE" });
    expect(m(new TransportError("CONNECTOR_HOST_NOT_ALLOWED", "NOT_STARTED", false, "PRE_IO", false))).toMatchObject({ kind: "UNAVAILABLE", errorClass: "PERMANENT" });
    expect(m(new AccessDeniedError("EGRESS_MODEL_REGION_NOT_APPROVED"))).toMatchObject({ kind: "UNAVAILABLE", reasonCode: "EGRESS_MODEL_REGION_NOT_APPROVED", outcome: "NOT_STARTED" });
    expect(m(new DependencyError("SOMETHING", "UNKNOWN", false))).toMatchObject({ kind: "FAILED", errorClass: "UNKNOWN" });
    expect(m(new Error("raw"))).toMatchObject({ kind: "FAILED", reasonCode: "UNCLASSIFIED_ERROR", errorClass: "UNKNOWN" });
    // Model inference has no side effect: a failure after send is never an UNKNOWN commit.
    expect(m(new TransportError("CONNECTION_LOST", "FAILED", true, "SENT", true)).outcome).toBe("FAILED");
  });

  it("[FO-09-45] Retry-After: retry-after-ms first, then seconds or an HTTP date, capped", () => {
    const now = new Date("2026-10-21T12:00:00Z");
    expect(retryAfterFrom({ "retry-after-ms": "1500", "retry-after": "9" }, now)).toBe(1500);
    expect(retryAfterFrom({ "retry-after": "2" }, now)).toBe(2000);
    expect(retryAfterFrom({ "retry-after": "Wed, 21 Oct 2026 12:00:05 GMT" }, now)).toBe(5000);
    expect(retryAfterFrom({ "retry-after": "86400" }, now)).toBe(120_000);
    expect(retryAfterFrom({ "retry-after": "soon" }, now)).toBeNull();
    expect(retryAfterFrom({}, now)).toBeNull();
  });

  it("[FO-09-45] incremental watchdog: a stream that never starts is FIRST_EVENT, one that stalls is STREAM_IDLE, and the exchange is aborted", async () => {
    async function* source(gaps: number[]): AsyncIterable<Buffer> {
      for (const g of gaps) {
        await new Promise((r) => setTimeout(r, g));
        yield Buffer.from("x");
      }
    }
    let aborted = 0;
    const drain = async (gaps: number[]) => {
      const out: Buffer[] = [];
      for await (const c of watched(source(gaps), { incremental: true, firstEventTimeoutMs: 80, idleTimeoutMs: 80, abort: () => (aborted += 1) })) out.push(c);
      return out.length;
    };
    expect(await drain([5, 5, 5])).toBe(3);
    await expect(drain([300])).rejects.toMatchObject({ reasonCode: "MODEL_FIRST_EVENT_TIMEOUT", timeoutPhase: "FIRST_EVENT" });
    await expect(drain([5, 300])).rejects.toMatchObject({ reasonCode: "MODEL_STREAM_IDLE_TIMEOUT", timeoutPhase: "STREAM_IDLE" });
    expect(aborted).toBe(2);
    // A buffered exchange is passed through untouched (the attempt timeout bounds it instead).
    let n = 0;
    for await (const _c of watched(source([150]), { incremental: false, firstEventTimeoutMs: 10, idleTimeoutMs: 10, abort: () => undefined })) n += 1;
    expect(n).toBe(1);
    expect(new ModelCallError({ kind: "TIMED_OUT", reasonCode: "X_Y", errorClass: "RETRYABLE" }).final().errorClass).toBe("PERMANENT");
  });
});
