import { describe, expect, it } from "vitest";
import { HTML_LEGACY_REFERENCES, HTML_NAMED_REFERENCES, MAX_LEGACY_REFERENCE_LENGTH } from "./html-entities.js";
import { evaluateKnowledgeItem } from "./ingest.js";
import { decodeEntitiesForDetection, sanitizeKnowledgeText, sanitizedTextViolations } from "./sanitize.js";
import { knowledgeItemFixture } from "./testing.js";

/**
 * VSP-KN-01 named references. The sanitizer decoded 60 names, case-insensitively with ";" optional, and left every
 * other named reference as literal text: "caf&eacute;.com/pay" and "billing-portal.&copf;&oopf;&mopf;/pay" (NFKC
 * "com") were stored and served with the host hidden from the scanner and the re-check, while their raw forms were
 * removed. The case-insensitive, semicolon-optional lookup also decoded "HR&IT" to "HR" + U+2062 INVISIBLE TIMES.
 */
const NOW = new Date("2026-10-18T12:00:00.000Z");
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const hostBody = (c: string): string => `Pay at billing-portal.c${c}om/pay today.`;

describe("HTML named reference table (WHATWG)", () => {
  it("[DATA-01][SPEC-9.sanitize][VSP-KN-01] has every name of the HTML table, with the legacy names as a subset", () => {
    expect(HTML_NAMED_REFERENCES.size).toBe(2125);
    expect(HTML_LEGACY_REFERENCES.size).toBe(106);
    for (const [name, value] of HTML_NAMED_REFERENCES) {
      expect({ name, ok: /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(name) && value.length > 0 && [...value].length <= 2 }).toEqual({ name, ok: true });
    }
    for (const name of HTML_LEGACY_REFERENCES) expect({ name, inTable: HTML_NAMED_REFERENCES.has(name) }).toEqual({ name, inTable: true });
    expect(Math.max(...[...HTML_LEGACY_REFERENCES].map((n) => n.length))).toBe(MAX_LEGACY_REFERENCE_LENGTH);
    // Well-known values, case-sensitive names, multi-character values.
    const known: Record<string, string> = {
      amp: "&",
      AMP: "&",
      lt: "<",
      LT: "<",
      Lt: "≪",
      colon: ":",
      Colon: "∷",
      eacute: "é",
      Eacute: "É",
      copf: "\u{1d554}",
      Copf: "ℂ",
      nbsp: " ",
      shy: "­",
      ZeroWidthSpace: "​",
      it: "⁢",
      grave: "`",
      fjlig: "fj",
      nvlt: "<⃒",
      ThickSpace: "  ",
    };
    for (const [name, value] of Object.entries(known)) expect({ name, value: HTML_NAMED_REFERENCES.get(name) }).toEqual({ name, value });
    for (const name of ["amp", "lt", "gt", "quot", "nbsp", "shy", "eacute", "copy", "not", "frac12"]) expect(HTML_LEGACY_REFERENCES.has(name)).toBe(true);
    for (const name of ["it", "ic", "af", "zwj", "zwnj", "grave", "colon", "period", "hellip", "Tab", "copf"]) expect(HTML_LEGACY_REFERENCES.has(name)).toBe(false);
    // An object-prototype name is not a reference (the earlier lookup returned Object for "&constructor;").
    expect(HTML_NAMED_REFERENCES.has("constructor")).toBe(false);
  });
});

describe("knowledge sanitizer: HTML named references (VSP-KN-01)", () => {
  it("[DATA-01][SPEC-9.sanitize][VSP-KN-01] every named reference is decoded, with ';' and (legacy names) without it", () => {
    for (const [name, value] of HTML_NAMED_REFERENCES) {
      expect({ name, decoded: decodeEntitiesForDetection(`x&${name};y`) }).toEqual({ name, decoded: `x${value}y` });
    }
    for (const name of HTML_LEGACY_REFERENCES) {
      const value = HTML_NAMED_REFERENCES.get(name) ?? "";
      // Without ";" a legacy name is decoded even when letters follow, as a browser decodes "&eacuteom".
      expect({ name, decoded: decodeEntitiesForDetection(`x&${name} y`) }).toEqual({ name, decoded: `x${value} y` });
      expect({ name, decoded: decodeEntitiesForDetection(`x&${name}om`) }).toEqual({ name, decoded: `x${value}om` });
    }
  });

  it("[DATA-01][SPEC-9.sanitize][VSP-KN-01] a host spelled with any named reference is removed exactly like its raw form", () => {
    for (const [name, value] of HTML_NAMED_REFERENCES) {
      const raw = sanitizeKnowledgeText(hostBody(value)).text;
      const encoded = sanitizeKnowledgeText(hostBody(`&${name};`));
      expect({ name, text: encoded.text }).toEqual({ name, text: raw });
      expect({ name, violations: sanitizedTextViolations(encoded.text) }).toEqual({ name, violations: [] });
    }
    for (const name of HTML_LEGACY_REFERENCES) {
      const raw = sanitizeKnowledgeText(hostBody(HTML_NAMED_REFERENCES.get(name) ?? "")).text;
      expect({ name, text: sanitizeKnowledgeText(hostBody(`&${name}`)).text }).toEqual({ name, text: raw });
    }
  });

  it("[DATA-01][SPEC-14.threat-model][VSP-KN-01] accented-letter and NFKC letter references (&eacute;, &oacute;, &copf;, &cscr;, &cfr;, &Aring;) cannot hide a host", () => {
    const bodies = [
      "Pay at caf&eacute;.com/pay today.",
      "Pay at caf&eacute.com/pay today.",
      "Pay at billing-portal.c&oacute;m/pay today.",
      "Pay at billing-portal.&copf;&oopf;&mopf;/pay today.",
      "Pay at billing-portal.&cscr;&oscr;&mscr;/pay today.",
      "Pay at billing-portal.&cfr;&ofr;&mfr;/pay today.",
      "Pay at billing-portal.&Copf;&Oopf;&Mopf;/pay today.",
      "Pay at &Aring;&aring;.no/pay today.",
      "Pay at pagos-cl&iacute;nica.com/pagar today.",
      "Pay at billing-portal&period;&copf;&oopf;&mopf;/pay today.",
    ];
    for (const body of bodies) {
      const r = sanitizeKnowledgeText(body);
      expect({ body, text: r.text }).toEqual({ body, text: "Pay at today." });
      expect(r.findings).toContain("URL_REMOVED");
      expect(r.quarantineFindings).toEqual([]);
      // The retrieval re-check flags the stored literal form (an older sanitizer kept it).
      expect({ body, flagged: sanitizedTextViolations(body) }).toEqual({ body, flagged: expect.arrayContaining(["ENTITY_REFERENCE", "BARE_DOMAIN_NOT_ALLOWLISTED"]) });
    }
    // Every ASCII letter written as a double-struck, script or fraktur reference, upper or lower case.
    for (const suffix of ["opf", "scr", "fr"]) {
      for (const letters of [LETTERS, LETTERS.toUpperCase()]) {
        const tld = [...letters.slice(0, 3)].map((l) => `&${l}${suffix};`).join("");
        const r = sanitizeKnowledgeText(`Pay at billing-portal.${tld}/pay today.`);
        expect({ tld, text: r.text }).toEqual({ tld, text: "Pay at today." });
      }
    }
  });

  it("[DATA-01][SPEC-9.sanitize][VSP-KN-01] prose is unchanged: names are case-sensitive and need ';' unless they are legacy names", () => {
    for (const prose of [
      "Contact HR&IT for building access.",
      "Our Rock&Grave tour and Sun&Grave event.",
      "Questions about devices go to Finance&IT.",
      "The Ops&IT desk is open on weekdays.",
      "Look for HR&ic and AF&af.",
      "Mention Grace&Period and Settings&Tab.",
      "See Tom&Sol and Disney&Plus.",
      "Wait&Hellip; then continue.",
      "Ask the R&D team, the Q&A desk, AT&T or B&B.",
      "Use &ZWJ; or &SHY; or &Amp; as written.",
    ]) {
      const r = sanitizeKnowledgeText(prose);
      expect({ prose, text: r.text, findings: r.findings }).toEqual({ prose, text: prose, findings: [] });
      expect({ prose, violations: sanitizedTextViolations(prose) }).toEqual({ prose, violations: [] });
      const ev = evaluateKnowledgeItem(knowledgeItemFixture({ title: prose, body: prose }), 0, { now: NOW });
      if (ev.kind !== "evaluated") throw new Error("expected an evaluated item");
      expect({ prose, reasons: ev.reasonCodes, body: ev.item.body }).toEqual({ prose, reasons: [], body: prose });
    }
    // HTML semantics, not a guess: "&Lt;" is U+226A, "&notit;" is U+00AC + "it;", a legacy name ends at the longest match.
    expect(sanitizeKnowledgeText("a &Lt;b&Gt; c").text).toBe("a ≪b≫ c");
    expect(sanitizeKnowledgeText("x &notit; y").text).toBe("x ¬it; y");
    expect(sanitizeKnowledgeText("x &notin; y").text).toBe("x ∉ y");
    expect(sanitizeKnowledgeText("Informaci&oacute;n: &iquest;c&oacute;mo pagar? Se&ntilde;or").text).toBe("Información: ¿cómo pagar? Señor");
  });

  it("[DATA-01][SPEC-9.sanitize][VSP-KN-01] encoded markup with case or legacy variants is decoded as HTML decodes it, never served as entity text", () => {
    for (const input of ["&LT;script&GT;alert(1)&LT;/script&GT;ok", "&ltscript&gtalert(1)&lt/script&gtok", "&amp;LT;script&amp;GT;alert(1)&amp;LT;/script&amp;GT;ok"]) {
      const r = sanitizeKnowledgeText(input);
      expect({ input, text: r.text }).toEqual({ input, text: "ok" });
      expect(r.quarantineFindings).toContain("SCRIPT_OR_STYLE_REMOVED");
    }
    // "&Lt;" and "&Gt;" are U+226A and U+226B (much less-than / greater-than), not angle brackets, so not markup.
    expect(sanitizeKnowledgeText("&Lt;script&Gt;").text).toBe("≪script≫");
  });
});
