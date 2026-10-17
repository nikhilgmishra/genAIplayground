import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TIME_ZONE_NAMES, isValidCalendarDate, renderSlotValue, spellOut, validateSlotValue } from "./slots.js";
import type { CatalogSlotSpec } from "./slots.js";

const spec = (type: CatalogSlotSpec["type"], extra: Partial<CatalogSlotSpec> = {}): CatalogSlotSpec => ({ type, ...extra });

describe("slot validation", () => {
  it("[ACT-05] dates must be real calendar dates in YYYY-MM-DD", () => {
    fc.assert(
      fc.property(fc.date({ min: new Date("1900-01-01T00:00:00Z"), max: new Date("2100-12-31T00:00:00Z"), noInvalidDate: true }), (d) => {
        const iso = d.toISOString().slice(0, 10);
        expect(validateSlotValue(spec("date"), iso).ok).toBe(true);
      }),
      { numRuns: 300, seed: 1 },
    );
    for (const bad of ["2026-02-29", "2026-13-01", "2026-00-10", "20261031", "2026-10-31T00:00:00Z", "1899-12-31", ""]) {
      expect(validateSlotValue(spec("date"), bad).ok, bad).toBe(false);
    }
    expect(isValidCalendarDate("2028-02-29")).toBe(true);
  });

  it("[ACT-05] money is an integer number of minor units (never a string, float, negative or boolean)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (n) => {
        expect(validateSlotValue(spec("money_minor_usd"), n).ok).toBe(true);
        const rendered = renderSlotValue(spec("money_minor_usd"), n, "en");
        // Rendering round-trips to the same number of minor units.
        expect(Number(rendered.replace(/[$,]/g, "").replace(".", ""))).toBe(n);
      }),
      { numRuns: 300, seed: 2 },
    );
    for (const bad of [1.5, -1, "100", true, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_001]) {
      expect(validateSlotValue(spec("money_minor_usd"), bad as never).ok).toBe(false);
    }
  });

  it("[ACT-05] person display names follow the allowlist pattern; anything else fails", () => {
    for (const good of ["Avery", "Dr. Morgan", "O'Neil", "Mary-Kate", "J R"]) expect(validateSlotValue(spec("person_display_name"), good).ok, good).toBe(true);
    for (const bad of ["", " Avery", "Avery ", "1990-01-01", "Avery{x}", "José", "a".repeat(62), "Avery  Two", "<b>Avery</b>"]) {
      expect(validateSlotValue(spec("person_display_name"), bad).ok, bad).toBe(false);
    }
  });

  it("[ACT-05] time zones come from an IANA allowlist and render as named zones", () => {
    for (const tz of Object.keys(TIME_ZONE_NAMES)) expect(validateSlotValue(spec("time_zone"), tz).ok).toBe(true);
    expect(validateSlotValue(spec("time_zone"), "UTC").ok).toBe(false);
    expect(validateSlotValue(spec("time_zone"), "toString").ok).toBe(false);
    expect(renderSlotValue(spec("time_zone"), "America/New_York", "es")).toBe("hora del Este");
  });

  it("[ACT-05] support references, spelled codes, counts, enums and portal paths are validated by type", () => {
    expect(validateSlotValue(spec("support_reference"), "SR-ABCD-2345").ok).toBe(true);
    expect(validateSlotValue(spec("support_reference"), "SR-ABCO-2345").ok).toBe(false);
    expect(validateSlotValue(spec("spelled_code"), "AB12").ok).toBe(true);
    expect(validateSlotValue(spec("spelled_code"), "AB 12").ok).toBe(false);
    expect(validateSlotValue(spec("count"), 3).ok).toBe(true);
    expect(validateSlotValue(spec("count"), 2.5).ok).toBe(false);
    expect(validateSlotValue(spec("enum", { enumValues: ["A"] }), "A").ok).toBe(true);
    expect(validateSlotValue(spec("enum", { enumValues: ["A"] }), "B").ok).toBe(false);
    expect(validateSlotValue(spec("portal_path"), "/portal/billing/statements").ok).toBe(true);
    for (const bad of ["/admin", "/portal", "/portal/", "/portal//x", "/portal/a?b=c", "/portal/A"]) expect(validateSlotValue(spec("portal_path"), bad).ok, bad).toBe(false);
  });

  it("[ACT-05] times are HH:MM 24h and render as 12-hour times", () => {
    expect(renderSlotValue(spec("time"), "00:05", "en")).toBe("12:05 AM");
    expect(renderSlotValue(spec("time"), "17:30", "en")).toBe("5:30 PM");
    expect(renderSlotValue(spec("time"), "12:00", "es")).toBe("12:00 p. m.");
    for (const bad of ["24:00", "7:30", "07:60", "0730"]) expect(validateSlotValue(spec("time"), bad).ok, bad).toBe(false);
  });

  it("[SPEC-11.confirmation] spelling renders letters, digits and punctuation words per language", () => {
    expect(spellOut("ab1", "en")).toBe("A, B, 1");
    expect(spellOut("O'N-a", "es")).toBe("O, apóstrofo, N, guion, A");
    expect(renderSlotValue(spec("person_display_name", { spell: true }), "Avery", "es")).toBe("Avery, que se deletrea A, V, E, R, Y");
  });
});
