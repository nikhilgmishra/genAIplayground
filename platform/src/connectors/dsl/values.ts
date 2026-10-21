/**
 * The closed function set of the mapping DSL (FO-06-23): typed casts, enum maps, date and zone
 * parsing and unit conversion. There is nothing else: no string templates, no arithmetic beyond the
 * fixed unit table, no regular expressions from configuration, no code. Every function is total: it
 * returns a value or a typed failure kind, never throws on vendor data and always terminates.
 */
import type { DriftKind } from "./errors.js";

export type FieldType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "instant"
  | "date"
  | "money_minor_units"
  | "currency_code"
  | "enum_code"
  | "opaque_id";

export type MappedValue = string | number | boolean | null;

export type CastResult = { ok: true; value: MappedValue } | { ok: false; kind: DriftKind };

const fail = (kind: DriftKind): CastResult => ({ ok: false, kind });
const ok = (value: MappedValue): CastResult => ({ ok: true, value });

/** Largest string the DSL copies (a vendor field longer than this is refused, never truncated silently). */
export const MAX_STRING_LENGTH = 4_000;

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days && y >= 1900 && y <= 2200;
}

/** Normalizes an ISO-8601 instant WITH an offset to UTC (`...Z`, millisecond precision). */
export function normalizeInstant(v: string): string | null {
  const m = ISO_INSTANT.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (!validDate(y, mo, d) || h > 23 || mi > 59 || s > 59) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  let f = formatterCache.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return null;
    }
    formatterCache.set(zone, f);
  }
  return f;
}

/** True when the IANA zone is known to this runtime's time-zone database. */
export function isKnownZone(zone: string): boolean {
  return zoneFormatter(zone) !== null;
}

/** Offset (ms) of `zone` at UTC instant `t`: wall clock in the zone minus UTC. */
function zoneOffsetMs(zone: string, t: number): number | null {
  const f = zoneFormatter(zone);
  if (!f) return null;
  const parts = Object.fromEntries(f.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(t / 1000) * 1000;
}

/**
 * Wall-clock local date-time in a business time zone -> UTC instant. Two fixed-point passes resolve
 * the offset (DST transitions included); a wall-clock time that does not exist in the zone (spring
 * forward gap) is refused rather than shifted.
 */
export function zonedLocalToUtc(local: string, zone: string): string | null {
  const m = LOCAL_DATETIME.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const s = m[6] === undefined ? 0 : Number(m[6]);
  if (!validDate(y, mo, d) || h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const o1 = zoneOffsetMs(zone, wall);
  if (o1 === null) return null;
  let t = wall - o1;
  const o2 = zoneOffsetMs(zone, t);
  if (o2 === null) return null;
  if (o2 !== o1) t = wall - o2;
  const check = zoneOffsetMs(zone, t);
  if (check === null || t + check !== wall) return null;
  return new Date(t).toISOString();
}

const UNIT_FACTORS: Record<string, { dim: "time" | "money"; perBase: number }> = {
  milliseconds: { dim: "time", perBase: 1 },
  seconds: { dim: "time", perBase: 1_000 },
  minutes: { dim: "time", perBase: 60_000 },
  hours: { dim: "time", perBase: 3_600_000 },
  days: { dim: "time", perBase: 86_400_000 },
  minor_units: { dim: "money", perBase: 1 },
  major_units: { dim: "money", perBase: 100 },
};

/** The closed unit table: `unit:<from>:<to>`. */
export const UNITS = Object.freeze(Object.keys(UNIT_FACTORS));

export function unitCompatible(from: string, to: string): boolean {
  const a = UNIT_FACTORS[from];
  const b = UNIT_FACTORS[to];
  return a !== undefined && b !== undefined && a.dim === b.dim;
}

/** Exact decimal string -> scaled integer (no binary floating point for money). */
function decimalToScaled(raw: string | number, scale: number): number | null {
  const s = typeof raw === "number" ? (Number.isFinite(raw) ? raw.toString() : "") : raw;
  const m = /^(-?)(\d{1,13})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  const digits = Math.round(Math.log10(scale));
  const frac = m[3] ?? "";
  if (frac.length > digits && /[1-9]/.test(frac.slice(digits))) return null; // precision would be lost
  const fracPadded = (frac + "0".repeat(digits)).slice(0, digits);
  const n = Number(m[2]) * scale + (digits > 0 ? Number(fracPadded) : 0);
  if (!Number.isSafeInteger(n)) return null;
  return m[1] === "-" ? -n : n;
}

/** Converts a value between units of the same dimension; integer results only (precision loss is drift). */
export function convertUnit(value: unknown, from: string, to: string): CastResult {
  const a = UNIT_FACTORS[from];
  const b = UNIT_FACTORS[to];
  if (!a || !b || a.dim !== b.dim) return fail("UNIT_MISMATCH");
  if (typeof value !== "number" && typeof value !== "string") return fail("TYPE_MISMATCH");
  if (a.perBase >= b.perBase) {
    const factor = a.perBase / b.perBase;
    if (!Number.isInteger(factor)) return fail("UNIT_MISMATCH");
    const scaled = decimalToScaled(value, factor);
    return scaled === null ? fail("TYPE_MISMATCH") : ok(scaled);
  }
  const divisor = b.perBase / a.perBase;
  const n = typeof value === "number" ? value : /^-?\d{1,15}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n % divisor !== 0) return fail("UNIT_MISMATCH");
  return ok(n / divisor);
}

/** Typed cast of one vendor value. `null`/`undefined` are handled by the caller (requirement classes). */
export function castValue(value: unknown, type: FieldType): CastResult {
  switch (type) {
    case "string":
      if (typeof value !== "string") return fail("TYPE_MISMATCH");
      return value.length > MAX_STRING_LENGTH ? fail("VALUE_TOO_LARGE") : ok(value);
    case "integer":
    case "money_minor_units": {
      const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d{1,15}$/.test(value) ? Number(value) : Number.NaN;
      return Number.isSafeInteger(n) ? ok(n) : fail("TYPE_MISMATCH");
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? ok(value) : fail("TYPE_MISMATCH");
    case "boolean":
      return typeof value === "boolean" ? ok(value) : fail("TYPE_MISMATCH");
    case "instant": {
      if (typeof value !== "string") return fail("TYPE_MISMATCH");
      if (ISO_DATE.test(value) || LOCAL_DATETIME.test(value)) return fail("ZONE_MISMATCH"); // no offset: zone unknown
      const n = normalizeInstant(value);
      return n === null ? fail("TYPE_MISMATCH") : ok(n);
    }
    case "date": {
      if (typeof value !== "string") return fail("TYPE_MISMATCH");
      const m = ISO_DATE.exec(value);
      if (!m) return ISO_INSTANT.test(value) ? fail("ZONE_MISMATCH") : fail("TYPE_MISMATCH");
      return validDate(Number(m[1]), Number(m[2]), Number(m[3])) ? ok(value) : fail("TYPE_MISMATCH");
    }
    case "currency_code":
      return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? ok(value) : fail("TYPE_MISMATCH");
    case "enum_code":
      return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? ok(value) : fail("TYPE_MISMATCH");
    case "opaque_id":
      return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? ok(value) : typeof value === "number" && Number.isSafeInteger(value) ? ok(String(value)) : fail("TYPE_MISMATCH");
  }
}

/** Parsed `FieldMapping.semantic` code: the only semantic transforms the DSL knows. */
export type Semantic =
  | { kind: "enum"; tableId: string }
  | { kind: "unit"; from: string; to: string }
  | { kind: "zone"; zoneKey: string }
  | { kind: "label"; code: string }
  /** A code with a transform prefix (`enum:`, `unit:`, `zone:`) that does not parse: a definition error. */
  | { kind: "invalid"; code: string };

/**
 * `enum:<tableId>` (enum map), `unit:<from>:<to>` (unit conversion), `zone:<zoneKey>` (wall-clock time in a
 * business time zone -> UTC); any other code is a descriptive label checked against metadata only.
 */
export function parseSemantic(code: string | null): Semantic | null {
  if (code === null) return null;
  const enumM = /^enum:([a-z][a-z0-9_.-]{1,60})$/.exec(code);
  if (enumM?.[1]) return { kind: "enum", tableId: enumM[1] };
  const unitM = /^unit:([a-z_]{2,20}):([a-z_]{2,20})$/.exec(code);
  if (unitM?.[1] && unitM[2]) return { kind: "unit", from: unitM[1], to: unitM[2] };
  const zoneM = /^zone:([a-z][a-z0-9_]{1,30})$/.exec(code);
  if (zoneM?.[1]) return { kind: "zone", zoneKey: zoneM[1] };
  if (/^(enum|unit|zone):/.test(code)) return { kind: "invalid", code };
  return { kind: "label", code };
}

/** Field types a semantic transform may produce. */
export function semanticAccepts(sem: Semantic, type: FieldType): boolean {
  switch (sem.kind) {
    case "enum":
      return type === "enum_code";
    case "unit":
      return type === "integer" || type === "money_minor_units";
    case "zone":
      return type === "instant";
    case "label":
      return true;
    case "invalid":
      return false;
  }
}

/** Applies a semantic transform to a raw vendor value and casts the result to the target type. */
export function applySemantic(value: unknown, sem: Semantic, type: FieldType, tables: { enums: ReadonlyMap<string, ReadonlyMap<string, string>>; zones: ReadonlyMap<string, string> }): CastResult {
  switch (sem.kind) {
    case "enum": {
      const table = tables.enums.get(sem.tableId);
      if (!table) return fail("UNKNOWN_ENUM_VALUE");
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return fail("TYPE_MISMATCH");
      const mapped = table.get(String(value));
      return mapped === undefined ? fail("UNKNOWN_ENUM_VALUE") : castValue(mapped, type);
    }
    case "unit": {
      const r = convertUnit(value, sem.from, sem.to);
      return r.ok ? castValue(r.value, type) : r;
    }
    case "zone": {
      const zone = tables.zones.get(sem.zoneKey);
      if (!zone || typeof value !== "string") return fail(zone ? "TYPE_MISMATCH" : "ZONE_MISMATCH");
      if (ISO_INSTANT.test(value)) return castValue(value, "instant");
      const utc = zonedLocalToUtc(value, zone);
      return utc === null ? fail("ZONE_MISMATCH") : ok(utc);
    }
    case "label":
      return castValue(value, type);
    case "invalid":
      return fail("TYPE_MISMATCH");
  }
}
