/**
 * Typed template slots: strict validation and deterministic spoken rendering
 * (spec section 11; ACT-05). Values reach a template only after validation by
 * type; anything else fails closed. Rendering is table-driven (no Intl/ICU
 * dependency) so output is identical across runtimes.
 *
 * Rendering helps the caller confirm exactly what will be committed: dates
 * with month names, 12-hour times, named time zones, amounts from integer
 * minor units, and optional spelling of names and codes.
 */
import { MATCH_CODE_PATTERN, MATCH_CODE_WORDS } from "../identity/match-code.js";
import type { SlotValue } from "../protocol/index.js";
import type { SlotType } from "./ports.js";

export interface CatalogSlotSpec {
  type: SlotType;
  enumValues?: string[];
  /** Spoken label per enum value, in the catalog's language. */
  labels?: Record<string, string>;
  /** Spell the value letter by letter (person_display_name, spelled_code). */
  spell?: boolean;
}

export type SlotLanguage = "en" | "es";

export type SlotCheck = { ok: true } | { ok: false; reasonCode: string };

/** IANA time zones the platform presents to callers (allowlist). */
export const TIME_ZONE_NAMES: Readonly<Record<string, Record<SlotLanguage, string>>> = Object.freeze({
  "America/New_York": { en: "Eastern Time", es: "hora del Este" },
  "America/Chicago": { en: "Central Time", es: "hora del Centro" },
  "America/Denver": { en: "Mountain Time", es: "hora de la Montaña" },
  "America/Phoenix": { en: "Arizona Time", es: "hora de Arizona" },
  "America/Los_Angeles": { en: "Pacific Time", es: "hora del Pacífico" },
  "America/Anchorage": { en: "Alaska Time", es: "hora de Alaska" },
  "Pacific/Honolulu": { en: "Hawaii Time", es: "hora de Hawái" },
  "America/Puerto_Rico": { en: "Atlantic Time", es: "hora del Atlántico" },
});

const MONTHS: Record<SlotLanguage, readonly string[]> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const PERSON_DISPLAY_NAME_RE = /^[A-Za-z][A-Za-z .'-]{0,60}$/;
export const SUPPORT_REFERENCE_RE = /^SR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const SPELLED_CODE_RE = /^[A-Za-z0-9]{1,24}$/;
const PORTAL_PATH_RE = /^\/portal(\/[a-z0-9-]{1,40}){1,6}$/;
const MAX_MONEY_MINOR = 1_000_000_000;
const MAX_COUNT = 100_000;

const MATCH_WORDS: ReadonlySet<string> = new Set(MATCH_CODE_WORDS);

/** A match code: exactly two DISTINCT words of the identity module's fixed list joined by "-". */
export function isValidMatchCode(value: string): boolean {
  if (!MATCH_CODE_PATTERN.test(value)) return false;
  const [a, b] = value.split("-") as [string, string];
  return a !== b && MATCH_WORDS.has(a) && MATCH_WORDS.has(b);
}

const fail = (reasonCode: string): SlotCheck => ({ ok: false, reasonCode });
const OK: SlotCheck = { ok: true };

export function isValidCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function validateSlotValue(spec: CatalogSlotSpec, value: SlotValue | undefined): SlotCheck {
  if (value === undefined) return fail("SLOT_MISSING");
  switch (spec.type) {
    case "date":
      return typeof value === "string" && isValidCalendarDate(value) ? OK : fail("SLOT_INVALID_DATE");
    case "time":
      return typeof value === "string" && TIME_RE.test(value) ? OK : fail("SLOT_INVALID_TIME");
    case "time_zone":
      return typeof value === "string" && Object.hasOwn(TIME_ZONE_NAMES, value) ? OK : fail("SLOT_INVALID_TIME_ZONE");
    case "money_minor_usd":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_MONEY_MINOR ? OK : fail("SLOT_INVALID_MONEY");
    case "person_display_name":
      return typeof value === "string" && PERSON_DISPLAY_NAME_RE.test(value) && !/\s{2,}/.test(value) && value.trim() === value
        ? OK
        : fail("SLOT_INVALID_PERSON_NAME");
    case "support_reference":
      return typeof value === "string" && SUPPORT_REFERENCE_RE.test(value) ? OK : fail("SLOT_INVALID_SUPPORT_REFERENCE");
    case "enum":
      return typeof value === "string" && (spec.enumValues ?? []).includes(value) ? OK : fail("SLOT_INVALID_ENUM");
    case "count":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? OK : fail("SLOT_INVALID_COUNT");
    case "spelled_code":
      return typeof value === "string" && SPELLED_CODE_RE.test(value) ? OK : fail("SLOT_INVALID_SPELLED_CODE");
    case "portal_path":
      return typeof value === "string" && value.startsWith("/portal/") && PORTAL_PATH_RE.test(value) ? OK : fail("SLOT_INVALID_PORTAL_PATH");
    case "match_code":
      return typeof value === "string" && isValidMatchCode(value) ? OK : fail("SLOT_INVALID_MATCH_CODE");
    default:
      return fail("SLOT_TYPE_UNKNOWN");
  }
}

function renderDate(value: string, lang: SlotLanguage): string {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const month = MONTHS[lang][m - 1] ?? "";
  return lang === "en" ? `${month} ${d}, ${y}` : `${d} de ${month} de ${y}`;
}

function renderTime(value: string, lang: SlotLanguage): string {
  const [hRaw, min] = value.split(":") as [string, string];
  const h = Number(hRaw);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const am = h < 12;
  return lang === "en" ? `${h12}:${min} ${am ? "AM" : "PM"}` : `${h12}:${min} ${am ? "a. m." : "p. m."}`;
}

function renderMoney(minor: number, lang: SlotLanguage): string {
  const dollars = Math.floor(minor / 100);
  const cents = String(minor % 100).padStart(2, "0");
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return lang === "en" ? `$${grouped}.${cents}` : `${grouped}.${cents} dólares`;
}

const SPELL_WORDS: Record<SlotLanguage, Record<string, string>> = {
  en: { " ": "space", "-": "hyphen", "'": "apostrophe", ".": "period" },
  es: { " ": "espacio", "-": "guion", "'": "apóstrofo", ".": "punto" },
};

export function spellOut(value: string, lang: SlotLanguage): string {
  return [...value].map((ch) => SPELL_WORDS[lang][ch] ?? ch.toUpperCase()).join(", ");
}

function renderPortalPath(value: string, lang: SlotLanguage): string {
  const segments = value.split("/").slice(2).map((s) => s.replace(/-/g, " "));
  return segments.join(lang === "en" ? ", then " : ", luego ");
}

/** Spoken rendering of an already-validated slot value. */
export function renderSlotValue(spec: CatalogSlotSpec, value: SlotValue, lang: SlotLanguage): string {
  switch (spec.type) {
    case "date":
      return renderDate(String(value), lang);
    case "time":
      return renderTime(String(value), lang);
    case "time_zone":
      return TIME_ZONE_NAMES[String(value)]?.[lang] ?? "";
    case "money_minor_usd":
      return renderMoney(Number(value), lang);
    case "person_display_name": {
      const name = String(value);
      if (!spec.spell) return name;
      return lang === "en" ? `${name}, spelled ${spellOut(name, lang)}` : `${name}, que se deletrea ${spellOut(name, lang)}`;
    }
    case "support_reference":
      return String(value)
        .split("-")
        .map((group) => [...group].join(" "))
        .join(", ");
    case "enum":
      return spec.labels?.[String(value)] ?? String(value);
    case "count":
      return String(value);
    case "spelled_code":
      return spellOut(String(value), lang);
    case "portal_path":
      return renderPortalPath(String(value), lang);
    case "match_code":
      // The two words with a pause between them; the same words are shown in the portal.
      return String(value).split("-").join(", ");
    default:
      return "";
  }
}
