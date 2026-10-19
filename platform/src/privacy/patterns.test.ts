import { describe, expect, it } from "vitest";
import { containsInvisibleOrControl, stripControl, stripInvisible, wordBreakingHiddenAsSpaces } from "./patterns.js";
import { redactText } from "./redaction.js";

// SYNTHETIC values only: 555-01xx fictional phone range.
const ch = (cp: number): string => String.fromCodePoint(cp);
const C1 = [0x80, 0x81, 0x85, 0x8d, 0x90, 0x9b, 0x9f];

describe("stripControl / stripInvisible (shared by redaction, logging, knowledge and search)", () => {
  it("[DATA-01][VSP-KN-01] stripControl removes C1 controls U+0080-009F as well as C0 controls and DEL; tab and newline stay, CR becomes a newline", () => {
    for (const cp of [...C1, 0x01, 0x0b, 0x0c, 0x1f, 0x7f]) expect({ cp, out: stripControl(`a${ch(cp)}b`) }).toEqual({ cp, out: "ab" });
    expect(stripControl("one\ttwo\r\nthree\rfour\n")).toBe("one\ttwo\nthree\nfour\n");
    // The Latin-1 letters right after the C1 block are visible text and stay.
    expect(stripControl(" éñÿ")).toBe(" éñÿ");
  });

  it("[DATA-01][VSP-KN-01] stripInvisible also removes U+2800 BRAILLE PATTERN BLANK (a blank filler that is not whitespace); other braille cells stay", () => {
    expect(stripInvisible(`a${ch(0x2800)}b`)).toBe("ab");
    expect(stripInvisible(`${ch(0x2801)}${ch(0x28ff)}`)).toBe(`${ch(0x2801)}${ch(0x28ff)}`);
  });

  it("[DATA-01][VSP-KN-01] containsInvisibleOrControl flags exactly what the two strips leave out (plus CR)", () => {
    for (const cp of [...C1, 0x01, 0x0d, 0x7f, 0x200b, 0x061c, 0xfeff, 0xe0041, 0x2800, 0x00ad, 0x200d]) {
      const s = `a${ch(cp)}b`;
      expect({ cp, flagged: containsInvisibleOrControl(s) }).toEqual({ cp, flagged: true });
      expect({ cp, flaggedAfterStrip: containsInvisibleOrControl(stripControl(stripInvisible(s))) }).toEqual({ cp, flaggedAfterStrip: false });
    }
    expect(containsInvisibleOrControl("Plain text with tab\t, newline\n, café and 予約.")).toBe(false);
  });

  it("[DATA-01][SPEC-9.sanitize][VSP-KN-01] wordBreakingHiddenAsSpaces reads controls, zero-width space, word joiner, BOM and blank fillers as a break, never an in-word character", () => {
    for (const cp of [...C1, 0x01, 0x0d, 0x1f, 0x7f, 0x200b, 0x2060, 0xfeff, 0x2800, 0x3164, 0xffa0]) {
      expect({ cp, out: wordBreakingHiddenAsSpaces(`a${ch(cp)}b`) }).toEqual({ cp, out: "a b" });
    }
    // Soft hyphen, ZWNJ, ZWJ, combining grapheme joiner, variation selectors, bidi marks, invisible times, tags.
    for (const cp of [0x00ad, 0x200c, 0x200d, 0x034f, 0xfe0f, 0xe0101, 0x200e, 0x202e, 0x2062, 0xe0041]) {
      expect({ cp, out: wordBreakingHiddenAsSpaces(`a${ch(cp)}b`) }).toEqual({ cp, out: `a${ch(cp)}b` });
    }
    expect(wordBreakingHiddenAsSpaces("tab\tand newline\n stay")).toBe("tab\tand newline\n stay");
  });

  it("[DATA-01][SPEC-6.redaction] a C1 control inside a phone number no longer hides it from redaction", () => {
    for (const cp of C1) {
      const r = redactText(`Call me at 555${ch(cp)}-0142 tomorrow.`, { minConfidence: 0 });
      expect(r.status).toBe("REDACTED");
      if (r.status !== "REDACTED") continue;
      expect({ cp, out: r.redacted }).toEqual({ cp, out: "Call me at [PHONE_1] tomorrow." });
    }
  });
});
