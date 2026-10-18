import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { replaceElements, replaceTags } from "./markup.js";

// The regexes the sanitizer used before VSP-KN-02. They are the semantic oracle here and are only
// ever run on short inputs (they are cubic/quadratic on long unterminated markup).
const OLD_ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(["']?)([^"'\s>]*)\1[^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi;
const BLOCK_NAMES = "script|style|iframe|object|embed|applet|form|noscript|template|svg|math|frameset|frame|base|link|meta";
const OLD_BLOCK = new RegExp(`<\\s*(${BLOCK_NAMES})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, "gi");
const HREF_ATTR = /\bhref\s*=\s*(["']?)([^"'\s>]*)\1/i;
const IMG_TAG = /<\s*img\b[^>]*>/gi;

const anchorsNew = (s: string): string =>
  replaceElements(s, /<(a)\b/gi, /<\s*\/\s*(a)\s*>/gi, (tag) => HREF_ATTR.exec(tag)?.[2] ?? null, (_n, target, text) => `{${text}|${target}}`);
const anchorsOld = (s: string): string => s.replace(OLD_ANCHOR, (_m, _q: string, target: string, text: string) => `{${text}|${target}}`);
const blocksNew = (s: string): string =>
  replaceElements(s, new RegExp(`<\\s*(${BLOCK_NAMES})\\b`, "gi"), new RegExp(`<\\s*\\/\\s*(${BLOCK_NAMES})\\s*>`, "gi"), () => "", (name) => `{${name}}`);
const blocksOld = (s: string): string => s.replace(OLD_BLOCK, (_m, name: string) => `{${name.toLowerCase()}}`);

const markupPiece = fc.constantFrom(
  "<a",
  "<A",
  "<a ",
  "<a href=",
  "<a href=x>",
  "<A HREF='y'>",
  ' href="z"',
  "href",
  "xhref=",
  "=",
  '"',
  "'",
  " ",
  ">",
  "<",
  "</a>",
  "</A >",
  "< / a >",
  "</a",
  "text",
  "<script>",
  "<SCRIPT src=x>",
  "</script>",
  "< /script >",
  "<style>",
  "</style>",
  "<frame>",
  "<frameset>",
  "</frameset>",
  "</frame>",
  "<script-x>",
  "<img",
  "<img src=x>",
  "\n",
);

describe("linear-time markup matching", () => {
  it("[SPEC-14.threat-model][VSP-KN-02] property: anchor pairing is exactly the old anchor regex on short inputs", () => {
    fc.assert(
      fc.property(fc.array(markupPiece, { maxLength: 24 }), (parts) => {
        const s = parts.join("");
        expect(anchorsNew(s)).toBe(anchorsOld(s));
      }),
      { numRuns: 3000, seed: 20261018 },
    );
  });

  it("[SPEC-14.threat-model][VSP-KN-02] property: block pairing is exactly the old block regex on short inputs", () => {
    fc.assert(
      fc.property(fc.array(markupPiece, { maxLength: 24 }), (parts) => {
        const s = parts.join("");
        expect(blocksNew(s)).toBe(blocksOld(s));
      }),
      { numRuns: 3000, seed: 20261019 },
    );
  });

  it("[SPEC-14.threat-model][VSP-KN-02] property: tag replacement up to the last '>' equals the plain regex replacement", () => {
    fc.assert(
      fc.property(fc.array(markupPiece, { maxLength: 24 }), (parts) => {
        const s = parts.join("");
        expect(replaceTags(s, IMG_TAG, () => "#")).toBe(s.replace(IMG_TAG, () => "#"));
      }),
      { numRuns: 2000, seed: 20261020 },
    );
  });

  it("[SPEC-14.threat-model][VSP-KN-02] unterminated anchors, blocks and tags at 40 000 chars are matched in linear time", () => {
    // The old anchor regex needed about 8 s for 8 000 chars of "<a href=" and grows cubically.
    const budgetMs = 1500;
    for (const unit of ["<a href=", "<a ", "<a href=x>", "<A HREF='", "<script ", "<script>", "<img ", "</a", "<a href=x></a"]) {
      const s = unit.repeat(Math.ceil(40_000 / unit.length)).slice(0, 40_000);
      const started = performance.now();
      anchorsNew(s);
      blocksNew(s);
      replaceTags(s, IMG_TAG, () => " ");
      const elapsed = performance.now() - started;
      expect({ unit, withinBudget: elapsed < budgetMs }).toEqual({ unit, withinBudget: true });
    }
  });
});
