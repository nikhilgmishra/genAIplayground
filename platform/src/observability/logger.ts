import pino from "pino";
import type { Logger, SafeFields, SafeFieldValue } from "./ports.js";

/**
 * Content-free structured logger. String field values are emitted only when the
 * key's category and the value's shape are both allowlisted; anything else is
 * replaced by "[redacted]". This blocks names, phone numbers, dates of birth,
 * verification codes, transcript text and dependency free text from logs
 * (DATA-01, AUTH-06) even when a caller mistakenly passes them.
 */
const OPAQUE_ID = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
const TURN_ID = /^turn_[A-Za-z0-9_-]{4,64}$/;
const SUPPORT_REF = /^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const UPPER_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const LOWER_TOKEN = /^[a-z][a-z0-9_.:@/-]{0,63}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const FOUR_DIGITS = /\d{4,}/;

type Category = "id" | "code" | "token" | "time" | "digest";

function categoryFor(key: string): Category | null {
  if (/(Id|Ref|^id|^ref)$/.test(key)) return "id";
  if (/(Code|Codes|reason|status|state|outcome|event|severity|route|level)$/i.test(key)) return "code";
  if (/(At|Time|Since|Until)$/.test(key)) return "time";
  if (/(Digest|Hash)$/.test(key)) return "digest";
  if (/^(tool|integration|component|action|method|version|environment|engine|channel|role|assurance|scope|topic|consumer|stream|kind|intent|queue|destinationId|purpose|template|templateId|locale|language)$/.test(key)) return "token";
  return null;
}

export function sanitizeValue(key: string, value: SafeFieldValue): SafeFieldValue {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  const cat = categoryFor(key);
  const v = String(value);
  switch (cat) {
    case "id":
      return OPAQUE_ID.test(v) || TURN_ID.test(v) || SUPPORT_REF.test(v) || UPPER_CODE.test(v) ? v : "[redacted]";
    case "code":
      return (UPPER_CODE.test(v) || LOWER_TOKEN.test(v)) && !FOUR_DIGITS.test(v) ? v : "[redacted]";
    case "token":
      return (LOWER_TOKEN.test(v) || UPPER_CODE.test(v) || /^[A-Za-z0-9_.@+-]{1,64}$/.test(v)) && !FOUR_DIGITS.test(v.replace(/^\d{4}-\d{2}-\d{2}/, "")) ? v : "[redacted]";
    case "time":
      return ISO_TS.test(v) ? v : "[redacted]";
    case "digest":
      return HEX_DIGEST.test(v) ? v : "[redacted]";
    default:
      return "[redacted]";
  }
}

export function sanitizeFields(fields: SafeFields | undefined): SafeFields {
  const out: SafeFields = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(k)) continue;
    out[k] = sanitizeValue(k, v);
  }
  return out;
}

export interface LogRecord {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields: SafeFields;
}

/** Event names are code-defined constants, e.g. "tool.invoke.denied". */
const EVENT_NAME = /^[a-z][a-z0-9_.]{2,80}$/;

class SafeLogger implements Logger {
  constructor(
    private readonly emit: (r: LogRecord) => void,
    private readonly bindings: SafeFields,
  ) {}
  private log(level: LogRecord["level"], event: string, fields?: SafeFields) {
    this.emit({ level, event: EVENT_NAME.test(event) ? event : "invalid_event_name", fields: { ...this.bindings, ...sanitizeFields(fields) } });
  }
  debug(event: string, fields?: SafeFields) {
    this.log("debug", event, fields);
  }
  info(event: string, fields?: SafeFields) {
    this.log("info", event, fields);
  }
  warn(event: string, fields?: SafeFields) {
    this.log("warn", event, fields);
  }
  error(event: string, fields?: SafeFields) {
    this.log("error", event, fields);
  }
  child(bindings: SafeFields): Logger {
    return new SafeLogger(this.emit, { ...this.bindings, ...sanitizeFields(bindings) });
  }
}

export function createLogger(opts: { service: string; level?: string } = { service: "vsp" }): Logger {
  const p = pino({ level: opts.level ?? process.env.LOG_LEVEL ?? "info", base: { service: opts.service }, messageKey: "event" });
  return new SafeLogger((r) => p[r.level]({ ...r.fields }, r.event), {});
}

/** LOCAL TEST FIXTURE: captures sanitized records in memory. */
export function createMemoryLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { logger: new SafeLogger((r) => records.push(r), {}), records };
}

export const silentLogger: Logger = new SafeLogger(() => undefined, {});
