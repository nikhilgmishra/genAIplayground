import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classifyRun, hostLiterals } from "./host-literals.js";

const MARK_LOW_LINE = String.fromCharCode(0x0332);
const MARK_ACUTE = String.fromCharCode(0x0301);
const MARK_ENCLOSING_CIRCLE = String.fromCharCode(0x20dd);
const ARABIC_INDIC_ZERO = String.fromCharCode(0x0660);
const IDEO_DOT = String.fromCharCode(0x3002);
const repeatTo = (unit: string, n: number): string => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
/**
 * Best of three runs, so one GC pause or scheduler hiccup cannot fail a strict budget. A run slower
 * than `giveUpMs` cannot be a hiccup; the remaining runs are skipped so a regression fails quickly.
 */
const bestOf3 = (fn: () => void, giveUpMs: number): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now();
    fn();
    const ms = performance.now() - started;
    best = Math.min(best, ms);
    if (ms > giveUpMs) break;
  }
  return best;
};

describe("VSP-KN-01: host literal classification", () => {
  it("[SPEC-14.threat-model][SPEC-9.sanitize][VSP-KN-01] a TLD label followed by decoration ('-', '_', digits, combining marks) is still a domain", () => {
    // The round-1 classifier missed every entry except the "evil.xn--p1ai" control (round-2 re-verification).
    for (const run of [
      "evil.com-",
      "evil.com--",
      "evil.com_",
      "evil.com-x",
      "evil.com1",
      `evil.com${ARABIC_INDIC_ZERO}`,
      `evil.com${MARK_LOW_LINE}`,
      `evil.com${MARK_ENCLOSING_CIRCLE}`,
      `evil.co${MARK_LOW_LINE}m`,
      `evil.c${MARK_ACUTE}om`,
      "secure-login.org-",
      "billing-portal.cc-",
      "evil..com",
      `evil${IDEO_DOT}${IDEO_DOT}com`,
      "evil.xn--p1ai",
      // Devanagari TLD: its vowel sign is a combining mark, which used to make the label fail the letters-only test.
      `evil.${String.fromCharCode(0x092d, 0x093e, 0x0930, 0x0924)}`,
    ]) {
      expect({ run, kind: classifyRun(run) }).toEqual({ run, kind: "DOMAIN" });
    }
  });

  it("[SPEC-14.threat-model][SPEC-9.sanitize][VSP-KN-01] IPv4 labels decorated with '-', '_' or combining marks are still IPv4", () => {
    // The round-1 classifier missed the decorated and double-dot forms; the last two entries are controls.
    for (const run of ["203.0.113.7-", "203.0.113.7_", "-203.0.113.7", `203.0.113.7${MARK_LOW_LINE}`, "203..0.113.7", "0xcb.0x0.0x71.0x7", "203.0.113.7"]) {
      expect({ run, kind: classifyRun(run) }).toEqual({ run, kind: "IPV4" });
    }
  });

  it("[SPEC-9.sanitize][VSP-KN-01] dotted administrative text whose later labels start with a digit or are single letters is not a host", () => {
    // "U.S.-based": a TLD label that starts with "-" is not classified (README, known limitations).
    for (const run of ["2.5", "v1.2", "v1.2.3", "a.m", "9.30am", "2.5GB", "1.5mg", "10.30", "e.g", "U.S", "U.S.-based", "Fig.3a", "1.2.3", "4.2"]) {
      expect({ run, kind: classifyRun(run) }).toEqual({ run, kind: null });
    }
  });

  it("[SPEC-14.threat-model][SPEC-9.sanitize][VSP-KN-01] hostLiterals reports a decorated domain together with its path", () => {
    const text = "Reset at evil.com-/reset now";
    const [lit, ...rest] = hostLiterals(text);
    expect(rest).toEqual([]);
    expect(lit && text.slice(lit.start, lit.end)).toBe("evil.com-/reset");
    // The decoration stays in the host, so a decorated allowlisted host can never match the allowlist.
    expect(lit?.host).toBe("evil.com-");
  });
});

describe("VSP-KN-02: host literal scanning is linear", () => {
  // The suffix pattern the memoized scanner replaces (sticky, applied at each literal's host end).
  const STICKY_SUFFIX = /(?::\d{1,5})?(?:\/[^\s<>"'`)\]]*)?/y;
  const expectedEnd = (text: string, hostEnd: number): number => {
    STICKY_SUFFIX.lastIndex = hostEnd;
    const m = STICKY_SUFFIX.exec(text);
    return hostEnd + (m ? m[0].length : 0);
  };
  const piece = fc.constantFrom(
    "a.bc",
    "a.bc/",
    "/",
    "//",
    ":",
    ":8443",
    ":123456",
    "1.2.3.4",
    "[::1]",
    "2001:db8::7",
    "x",
    "-",
    MARK_ACUTE,
    " ",
    "\n",
    ")",
    "]",
    "<",
    '"',
    "'",
    "`",
    ".",
    IDEO_DOT,
    "portal.synthetic-health.test",
  );

  it("[SPEC-14.threat-model][VSP-KN-02] property: memoized port/path ends equal the former sticky suffix regex for every literal", () => {
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 30 }), (parts) => {
        const text = parts.join("");
        for (const lit of hostLiterals(text)) {
          const unbracketedIpv6 = lit.kind === "IPV6" && !text.slice(lit.start, lit.hostEnd).endsWith("]");
          expect({ text, end: lit.end }).toEqual({ text, end: unbracketedIpv6 ? lit.hostEnd : expectedEnd(text, lit.hostEnd) });
        }
      }),
      { numRuns: 3000, seed: 20261018 },
    );
  });

  // Before the fix every literal rescanned the shared path to its end: 'a.bc/' took about 167 ms at
  // 40 000 chars and the combining-mark unit about 1 130 ms (about 4x per doubling); after it, each
  // takes a few milliseconds. 50 ms leaves room for slow shared runners and still fails the old scan.
  const STRICT_BUDGET_MS = 50;
  const UNITS = ["a.bc/", `${MARK_ACUTE}a.bc/`, "a.bc:1/", "1.2.3.4/", "a.bc/x", "a.bc-/"];

  it("[SPEC-14.threat-model][VSP-KN-02] 'a.bc/' and combining-mark units at 20 000 and 40 000 chars are scanned within a strict budget", () => {
    for (const unit of UNITS) {
      for (const n of [20_000, 40_000]) {
        const text = repeatTo(unit, n);
        const ms = bestOf3(() => hostLiterals(text), 10 * STRICT_BUDGET_MS);
        expect({ unit, n, withinBudget: ms < STRICT_BUDGET_MS }).toEqual({ unit, n, withinBudget: true });
      }
    }
  });

  it("[SPEC-14.threat-model][VSP-KN-02] scanning stays linear well beyond the sanitizer cap (160 000 chars)", () => {
    // The quadratic scan needed about 2.9 s ('a.bc/') and 19 s (combining mark) here; linear is tens of ms.
    for (const unit of ["a.bc/", `${MARK_ACUTE}a.bc/`]) {
      const text = repeatTo(unit, 160_000);
      const ms = bestOf3(() => hostLiterals(text), 80 * STRICT_BUDGET_MS);
      expect({ unit, withinBudget: ms < 8 * STRICT_BUDGET_MS }).toEqual({ unit, withinBudget: true });
    }
  });
});
