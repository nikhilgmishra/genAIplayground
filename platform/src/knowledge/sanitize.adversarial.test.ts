import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { TENANT_ID } from "../fixtures/synthetic-world.js";
import { FakeClock } from "../shared/clock.js";
import { LOCAL_ALLOWED_LINK_DOMAINS } from "./corpus.js";
import { evaluateKnowledgeItem } from "./ingest.js";
import { MAX_SANITIZE_INPUT_CHARS, sanitizeKnowledgeText, sanitizedTextViolations } from "./sanitize.js";
import { MAX_BODY_CHARS } from "./schema.js";
import { KnowledgeServicePg } from "./service.js";
import { createKnowledgeTestDb, knowledgeItemFixture } from "./testing.js";

const ALLOWED = ["portal.synthetic-health.test"];
const NOW = new Date("2026-10-17T15:00:00.000Z");
const IDEO_DOT = String.fromCharCode(0x3002);
const FULLWIDTH_DOT = String.fromCharCode(0xff0e);
const HALFWIDTH_IDEO_DOT = String.fromCharCode(0xff61);
const fold = (s: string): string => s.replace(/[\u3002\uFF0E\uFF61]/g, ".").toLowerCase();

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
});

describe("VSP-KN-01: no bare domain or IP literal outside the allowlist", () => {
  // The finder's and verifiers' inputs: every one of these came back unchanged before the fix.
  const cases: [string, string][] = [
    ["To reset your password go to account-help.support/reset and enter your code.", "account-help.support"],
    ["Pay at billing-portal.cc/pay or call our partner line.", "billing-portal.cc"],
    ["Visit 203.0.113.7/login for the new portal.", "203.0.113.7"],
    ["Go to evil.click/x today.", "evil.click"],
    ["Or secure.zip/y today.", "secure.zip"],
    ["Or login.page/z today.", "login.page"],
    [`Open portal${IDEO_DOT}evil${IDEO_DOT}com/reset now.`, "evil"],
    [`Open portal${HALFWIDTH_IDEO_DOT}evil${HALFWIDTH_IDEO_DOT}com/reset now.`, "evil"],
    [`Open portal${FULLWIDTH_DOT}evil${FULLWIDTH_DOT}com/reset now.`, "evil"],
    ["Use the backup host [2001:db8::7]:8443/login today.", "2001:db8"],
    ["Use 2001:db8:0:0:0:0:0:7 today.", "2001:db8"],
    ["Hex form 0xcb.0x0.0x71.0x7/login works too.", "0xcb"],
    ["Punycode host xn--80ak6aa92e.xn--p1ai/login works too.", "xn--"],
  ];

  it("[SPEC-14.threat-model][SPEC-9.sanitize][VSP-KN-01] bare domains on any TLD, IPv4/IPv6 literals and IDNA separators are removed", () => {
    for (const [input, needle] of cases) {
      const r = sanitizeKnowledgeText(input, { allowedLinkDomains: ALLOWED });
      expect({ input, out: fold(r.text).includes(fold(needle)) }).toEqual({ input, out: false });
      expect(r.findings).toContain("URL_REMOVED");
      expect(r.quarantineFindings).toEqual([]);
      expect(sanitizedTextViolations(r.text, ALLOWED)).toEqual([]);
    }
  });

  it("[SPEC-14.threat-model][SPEC-9.retrieval][VSP-KN-01] the retrieval re-check flags the same literals in stored text", () => {
    expect(sanitizedTextViolations("Pay at billing-portal.cc/pay.", ALLOWED)).toEqual(["BARE_DOMAIN_NOT_ALLOWLISTED"]);
    expect(sanitizedTextViolations("Visit account-help.support/reset.", ALLOWED)).toEqual(["BARE_DOMAIN_NOT_ALLOWLISTED"]);
    expect(sanitizedTextViolations(`Open portal${IDEO_DOT}evil${IDEO_DOT}com/reset.`, ALLOWED)).toEqual(["BARE_DOMAIN_NOT_ALLOWLISTED"]);
    expect(sanitizedTextViolations("Visit 203.0.113.7/login.", ALLOWED)).toEqual(["IP_LITERAL"]);
    expect(sanitizedTextViolations("Visit [2001:db8::7]/login.", ALLOWED)).toEqual(["IP_LITERAL"]);
    expect(sanitizedTextViolations("Sign in at portal.synthetic-health.test/help.", ALLOWED)).toEqual([]);
    // An allowlisted host does not launder a domain hidden in its path.
    expect(sanitizedTextViolations("portal.synthetic-health.test/go/billing-portal.cc", ALLOWED)).toEqual(["BARE_DOMAIN_NOT_ALLOWLISTED"]);
  });

  it("[SPEC-9.sanitize][VSP-KN-01] allowlisted hosts survive as plain text only; look-alikes and dotted paths do not", () => {
    const keep = sanitizeKnowledgeText("Sign in at portal.synthetic-health.test/help.", { allowedLinkDomains: ALLOWED });
    expect(keep.text).toBe("Sign in at portal.synthetic-health.test/help.");
    const folded = sanitizeKnowledgeText(`Sign in at PORTAL${IDEO_DOT}SYNTHETIC-HEALTH${IDEO_DOT}TEST today.`, { allowedLinkDomains: ALLOWED });
    expect(folded.text).toBe("Sign in at portal.synthetic-health.test today.");
    const hiddenInPath = sanitizeKnowledgeText("Go to portal.synthetic-health.test/go/billing-portal.cc now.", { allowedLinkDomains: ALLOWED });
    expect(hiddenInPath.text).toBe("Go to portal.synthetic-health.test now.");
    const lookalike = sanitizeKnowledgeText("Go to portal.synthetic-health.test.evil.cc/x now.", { allowedLinkDomains: ALLOWED });
    expect(lookalike.text).toBe("Go to now.");
    expect(sanitizeKnowledgeText("Go to sub.portal.synthetic-health.test now.", { allowedLinkDomains: ALLOWED }).text).toBe("Go to now.");
  });

  it("[SPEC-9.sanitize][VSP-KN-01] ordinary administrative text (amounts, times, versions, abbreviations) is unchanged", () => {
    for (const t of [
      "Your copay is $12.50 and the visit is at 10:30 a.m. on Oct. 5.",
      "Form version 2.1 replaces version 1.9, e.g. for U.S. residents.",
      "Allow 2.5 business days. Statements close at 17:00:00 each day.",
      "Plan B covers 80.5 percent; see section 4.2 of the handbook.",
    ]) {
      const r = sanitizeKnowledgeText(t, { allowedLinkDomains: ALLOWED });
      expect(r.text).toBe(t);
      expect(r.findings).toEqual([]);
    }
  });

  // Independent oracle: the generated literal (or its "." + TLD tail) must not appear in the output.
  // The old property used the sanitizer's own violation check as its oracle and only TLDs from its list.
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const label = fc.stringMatching(/^[a-z0-9](?:[a-z0-9-]{0,10}[a-z0-9])?$/);
  const tld = fc.string({ unit: fc.constantFrom(...letters.split("")), minLength: 2, maxLength: 12 }).filter((t) => t !== "test");
  const sep = fc.constantFrom(".", IDEO_DOT, FULLWIDTH_DOT, HALFWIDTH_IDEO_DOT);
  const suffix = fc.constantFrom("", "/", "/login", "/reset/now", ":8443", ":8443/pay", "?x=1");
  const domain = fc.record({ labels: fc.array(label, { minLength: 1, maxLength: 3 }), tld, sep, suffix, upper: fc.boolean() }).map((d) => {
    const host = [...d.labels, d.tld].join(d.sep);
    return { literal: `${d.upper ? host.toUpperCase() : host}${d.suffix}`, needles: [fold(host), `.${d.tld}`] };
  });
  const octet = fc.integer({ min: 0, max: 255 });
  const ipv4 = fc.record({ o: fc.tuple(octet, octet, octet, octet), suffix }).map(({ o, suffix: sfx }) => ({ literal: `${o.join(".")}${sfx}`, needles: [o.join(".")] }));
  const hex = fc.integer({ min: 1, max: 0xffff }).map((n) => n.toString(16));
  const ipv6 = fc
    .record({ g: fc.array(hex, { minLength: 8, maxLength: 8 }), form: fc.constantFrom("full", "compressed", "bracketed") })
    .map(({ g, form }) => {
      const core = form === "full" ? g.join(":") : `${g[0]}:${g[1]}::${g[7]}`;
      return { literal: form === "bracketed" ? `[${core}]:8443/login` : core, needles: [core] };
    });
  const filler = fc.constantFrom("Please", "visit", "then", "sign in", "pay your bill", "or", "call us", "(see", "today", "now", "-", ",");

  it("[SPEC-14.threat-model][SPEC-9.sanitize][VSP-KN-01] property: generated domains on arbitrary TLDs, IP literals and IDNA separators never survive", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(domain, ipv4, ipv6), { minLength: 1, maxLength: 4 }), fc.array(filler, { maxLength: 6 }), fc.constantFrom("", ".", ",", ")", "!"), (lits, words, trail) => {
        const text = [...words, ...lits.map((l) => `${l.literal}${trail}`), "thanks."].join(" ");
        const out = sanitizeKnowledgeText(text, { allowedLinkDomains: ALLOWED }).text;
        const folded = fold(out);
        for (const l of lits) for (const n of l.needles) expect({ text, survived: folded.includes(n) }).toEqual({ text, survived: false });
        expect(sanitizedTextViolations(out, ALLOWED)).toEqual([]);
      }),
      { numRuns: 1500, seed: 20261018 },
    );
  });

  // Round 2: all 24 inputs came back unchanged from the round-1 sanitizer. Decoration attached to the TLD
  // label ('-', '_', digits, combining marks, fullwidth or small dashes that NFKC folds to '-') made the label
  // fail a letters-only test, decoration on an octet made it non-numeric, and a doubled separator broke the run.
  const ch = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);
  const LOW_LINE_MARK = ch(0x0332);
  const decoratedCases: [string, string][] = [
    ["Reset at evil.com-/reset", "evil.com"],
    ["Reset at evil.com--/reset", "evil.com"],
    ["Reset at evil.net-", "evil.net"],
    ["Reset at secure-login.org-/a", "secure-login.org"],
    ["Pay at billing-portal.cc-/pay today", "billing-portal.cc"],
    ["Pay at billing-portal.com_/pay today", "billing-portal.com"],
    [`Reset at evil.com${LOW_LINE_MARK}/reset`, "evil.com"],
    [`Reset at evil.com${ch(0x20dd)}/reset`, "evil.com"],
    [`Reset at evil.com${ch(0x0353)}/reset`, "evil.com"],
    [`Reset at evil.com${ch(0x093c)}/reset`, "evil.com"],
    [`Reset at evil.co${LOW_LINE_MARK}m/reset`, "evil.com"],
    [`Open evil.c${LOW_LINE_MARK}om/reset`, "evil.com"],
    [`Reset at evil.com${ch(0xfe63)}/reset`, "evil.com"],
    [`Reset at evil.com${ch(0xff0d)}/reset`, "evil.com"],
    [`Pay at billing-portal.cc${ch(0xff0d)}/pay`, "billing-portal.cc"],
    [`Reset at evil.com${ch(0xff3f)}/reset`, "evil.com"],
    [`Reset at evil.com${ch(0x0660)}/reset`, "evil.com"],
    [`Reset at evil.com${ch(0x00b2)}/reset`, "evil.com"],
    [`Reset at evil.com${ch(0x2460)}/reset`, "evil.com"],
    ["Visit evil.com1/x", "evil.com"],
    ["Visit evil.com-secure/x", "evil.com"],
    ["Visit evil..com/x", "evil..com"],
    ["Visit 203.0.113.7-/login", "203.0.113.7"],
    ["Visit 203.0.113.7_/login", "203.0.113.7"],
  ];
  /** Independent oracle normalization: compatibility-decompose, delete combining marks, fold IDNA separators, lowercase. */
  const squash = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[\u3002\uFF0E\uFF61]/g, ".").toLowerCase();

  it("[SPEC-14.threat-model][SPEC-9.sanitize][VSP-KN-01] domains and IPv4 literals with decoration after the TLD or last octet are removed", () => {
    for (const [input, needle] of decoratedCases) {
      const r = sanitizeKnowledgeText(input, { allowedLinkDomains: ALLOWED });
      expect({ input, survived: squash(r.text).includes(squash(needle)) }).toEqual({ input, survived: false });
      expect({ input, findings: r.findings.includes("URL_REMOVED") }).toEqual({ input, findings: true });
      expect(r.quarantineFindings).toEqual([]);
      expect(sanitizedTextViolations(r.text, ALLOWED)).toEqual([]);
      // The retrieval re-check flags the same text if an older sanitizer stored it.
      expect({ input, flagged: sanitizedTextViolations(input.normalize("NFKC"), ALLOWED).length > 0 }).toEqual({ input, flagged: true });
    }
  });

  it("[SPEC-9.sanitize][VSP-KN-01] administrative text with digits or hyphens after a dot is unchanged", () => {
    for (const t of [
      "Office hours are 9.30am to 5pm; uploads may be up to 2.5MB each.",
      "Our U.S.-based team replies within 1.5 business days.",
      "Refer to Fig.3a and version 1.2.3 of the form.",
    ]) {
      const r = sanitizeKnowledgeText(t, { allowedLinkDomains: ALLOWED });
      expect(r.text).toBe(t);
      expect(r.findings).toEqual([]);
    }
  });

  // Generator: arbitrary-TLD domains with trailing decoration, marks inside the TLD and repeated separators.
  const MARKS = [0x0332, 0x0301, 0x20dd, 0x0353, 0x093c].map((cp) => ch(cp));
  const trailDecoration = fc.constantFrom(
    "-",
    "--",
    "_",
    "__",
    "-_",
    "-x",
    "_secure",
    "1",
    "42",
    "1x",
    ...MARKS,
    ch(0xff0d), // fullwidth hyphen-minus (NFKC "-")
    ch(0xfe63), // small hyphen-minus (NFKC "-")
    ch(0xff3f), // fullwidth low line (NFKC "_")
    ch(0x0660), // Arabic-Indic digit zero
    ch(0x06f1), // extended Arabic-Indic digit one
    ch(0x00b2), // superscript two (NFKC "2")
    ch(0x2460), // circled digit one (NFKC "1")
    ch(0x2010), // hyphen (not a label character: ends the run)
    ch(0x2212), // minus sign (not a label character)
    ch(0x203f), // undertie (not a label character)
    ch(0x00ad), // soft hyphen (invisible: removed)
  );
  const decoratedDomain = fc
    .record({
      labels: fc.array(label, { minLength: 1, maxLength: 2 }),
      tld,
      sep: fc.constantFrom(".", IDEO_DOT, FULLWIDTH_DOT, HALFWIDTH_IDEO_DOT, "..", `${IDEO_DOT}${IDEO_DOT}`),
      decoration: trailDecoration,
      innerMark: fc.option(fc.record({ at: fc.nat(), mark: fc.constantFrom(...MARKS) }), { nil: undefined }),
      suffix,
      upper: fc.boolean(),
    })
    .map((d) => {
      const at = d.innerMark ? d.innerMark.at % (d.tld.length + 1) : 0;
      const markedTld = d.innerMark ? `${d.tld.slice(0, at)}${d.innerMark.mark}${d.tld.slice(at)}` : d.tld;
      const host = [...d.labels, markedTld].join(d.sep);
      const shown = d.upper ? host.toUpperCase() : host;
      return { literal: `${shown}${d.decoration}${d.suffix}`, needles: [squash(`.${d.tld}`), squash([...d.labels, d.tld].join(d.sep))] };
    });
  const ipDecoration = fc.constantFrom("-", "_", "--", LOW_LINE_MARK, ch(0xff0d), ch(0xff3f), ch(0x0660));
  const decoratedIpv4 = fc.record({ o: fc.tuple(octet, octet, octet, octet), dec: ipDecoration, lead: fc.constantFrom("", "-", "_"), suffix }).map(({ o, dec, lead, suffix: sfx }) => ({
    literal: `${lead}${o.join(".")}${dec}${sfx}`,
    needles: [o.join(".")],
  }));

  it("[SPEC-14.threat-model][SPEC-9.sanitize][VSP-KN-01] property: decorated TLDs, marks inside the TLD, repeated separators and decorated IPv4 never survive (independent oracle)", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(decoratedDomain, decoratedIpv4), { minLength: 1, maxLength: 4 }), fc.array(filler, { maxLength: 6 }), fc.constantFrom("", ".", ",", ")", "!"), (lits, words, trail) => {
        const text = [...words, ...lits.map((l) => `${l.literal}${trail}`), "thanks."].join(" ");
        const out = sanitizeKnowledgeText(text, { allowedLinkDomains: ALLOWED }).text;
        const squashed = squash(out);
        for (const l of lits) for (const n of l.needles) expect({ text, survived: squashed.includes(n) }).toEqual({ text, survived: false });
        expect(sanitizedTextViolations(out, ALLOWED)).toEqual([]);
      }),
      { numRuns: 2000, seed: 20261019 },
    );
  });

  it("[SPEC-14.threat-model][SPEC-9.retrieval][VSP-KN-01] end to end: ingest + search never serves a decorated domain or IPv4 literal", async () => {
    const db = await createKnowledgeTestDb();
    closers.push(() => db.close());
    const svc = new KnowledgeServicePg({ db, environment: "local", clock: new FakeClock(NOW), embedder: null, allowedLinkDomains: LOCAL_ALLOWED_LINK_DOMAINS });
    const bodies: Record<string, string> = {
      "kn01r2-dash": "You can pay your balance online at billing-portal.com-/pay using a card.",
      "kn01r2-mark": `To pay your balance go to billing-portal.com${LOW_LINE_MARK}/pay and follow the steps.`,
      "kn01r2-fullwidth": `To pay your balance open billing-portal.cc${ch(0xff0d)}/pay and follow the steps.`,
      "kn01r2-ip": "To pay your balance visit 203.0.113.7-/pay and follow the steps.",
    };
    const intents = ["payment_help", "billing_question", "invoice_help", "balance_help"];
    const report = await svc.ingest(
      TENANT_ID,
      Object.entries(bodies).map(([sourceId, body], i) => knowledgeItemFixture({ sourceId, permittedIntents: [intents[i] ?? "payment_help"], body })),
    );
    expect(report.accepted.length).toBe(4);
    for (const intent of intents) {
      const hits = await svc.search({ tenantId: TENANT_ID, query: "pay balance", audience: "public", intent, language: "en", jurisdiction: "US", now: NOW, limit: 5 });
      expect(hits.length).toBe(1);
      for (const h of hits) {
        expect(squash(h.excerpt)).not.toMatch(/billing-portal\.c|203\.0\.113\.7/);
        expect(sanitizedTextViolations(h.excerpt, LOCAL_ALLOWED_LINK_DOMAINS)).toEqual([]);
      }
    }
  });

  it("[SPEC-14.threat-model][SPEC-9.retrieval][VSP-KN-01] end to end: ingest + search never serves a bare domain on a non-listed TLD or an IP literal", async () => {
    const db = await createKnowledgeTestDb();
    closers.push(() => db.close());
    const svc = new KnowledgeServicePg({ db, environment: "local", clock: new FakeClock(NOW), embedder: null, allowedLinkDomains: LOCAL_ALLOWED_LINK_DOMAINS });
    const bodies: Record<string, string> = {
      "kn01-cc": "You can pay your balance online at billing-portal.cc/pay using a card.",
      "kn01-support": "To pay your balance go to account-help.support/pay and follow the steps.",
      "kn01-ip": "To pay your balance visit 203.0.113.7/pay and follow the steps.",
      "kn01-ideo": `To pay your balance open billing${IDEO_DOT}evil${IDEO_DOT}com/pay and follow the steps.`,
    };
    // Separate intents so the items do not conflict with each other.
    const intents = ["payment_help", "billing_question", "invoice_help", "balance_help"];
    const report = await svc.ingest(
      TENANT_ID,
      Object.entries(bodies).map(([sourceId, body], i) => knowledgeItemFixture({ sourceId, permittedIntents: [intents[i] ?? "payment_help"], body })),
    );
    expect(report.accepted.length).toBe(4);
    for (const intent of intents) {
      const hits = await svc.search({ tenantId: TENANT_ID, query: "pay balance", audience: "public", intent, language: "en", jurisdiction: "US", now: NOW, limit: 5 });
      expect(hits.length).toBe(1);
      for (const h of hits) {
        expect(fold(h.excerpt)).not.toMatch(/billing-portal\.cc|account-help\.support|203\.0\.113\.7|evil\.com/);
        expect(sanitizedTextViolations(h.excerpt, LOCAL_ALLOWED_LINK_DOMAINS)).toEqual([]);
      }
    }
  });
});

describe("VSP-KN-02: sanitization time is linear and bounded", () => {
  // Generous for slow shared CI runners; after the fix each input takes tens of milliseconds, while the
  // old anchor pattern needed about 8 s for 8 000 chars and about 67 s for 16 000.
  const BUDGET_MS = 1500;
  const timed = (input: string): { ms: number; text: string } => {
    const started = performance.now();
    const r = sanitizeKnowledgeText(input, { allowedLinkDomains: ALLOWED });
    return { ms: performance.now() - started, text: r.text };
  };
  const repeatTo = (unit: string, n: number): string => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

  it("[SPEC-14.threat-model][VSP-KN-02] repeated '<a href=' and other unterminated markup at the schema maximum finish within budget", () => {
    const units = [
      "<a href=", // the finding
      "&lt;a href=", // entity-encoded form (decoded before matching)
      "<A HREF='",
      "<a ",
      "<a href=x>",
      "<a href=x></a",
      "<",
      "<script",
      "<script ",
      "<script>",
      "<img ",
      "<input ",
      "<b onab",
      "</a",
      "<http:",
      "[",
      "[](",
      "[x](",
      "![",
      "![x](",
      "`",
      "a.",
      "a1.",
      "1.",
      "1.2.3.4.",
      "a.xn--",
      "x.exe",
      "1:",
      "ff:",
      `a${IDEO_DOT}`,
    ];
    for (const unit of units) {
      const { ms, text } = timed(repeatTo(unit, MAX_BODY_CHARS));
      expect({ unit, withinBudget: ms < BUDGET_MS }).toEqual({ unit, withinBudget: true });
      expect(sanitizedTextViolations(text, ALLOWED)).toEqual([]);
    }
  });

  const dangerous = fc.constantFrom(
    "<a href=",
    "<a ",
    "href=",
    "<",
    ">",
    "</a",
    "</a>",
    "<script",
    "<script>",
    "</script>",
    "<img ",
    "<iframe ",
    " onx=",
    "<!--",
    "&lt;",
    "&amp;lt;",
    "[",
    "](",
    "![",
    "`",
    "```",
    "www.",
    "//",
    "http://",
    "javascript:",
    "data:a/b;",
    "a.",
    "1.",
    ".",
    ":",
    "::",
    "x.exe",
    " ",
  );

  it("[SPEC-14.threat-model][VSP-KN-02] property: any repeated composition of adversarial fragments at the schema maximum finishes within budget", () => {
    fc.assert(
      fc.property(fc.array(dangerous, { minLength: 1, maxLength: 5 }), (parts) => {
        const { ms, text } = timed(repeatTo(parts.join(""), MAX_BODY_CHARS));
        expect({ parts, withinBudget: ms < BUDGET_MS }).toEqual({ parts, withinBudget: true });
        expect(sanitizedTextViolations(text, ALLOWED)).toEqual([]);
      }),
      { numRuns: 40, seed: 20261018 },
    );
  });

  it("[SPEC-14.threat-model][VSP-KN-02] input over the cap, before or after NFKC expansion, fails closed and quarantines", () => {
    const tooLong = sanitizeKnowledgeText("a".repeat(MAX_SANITIZE_INPUT_CHARS + 1));
    expect(tooLong).toEqual({ text: "", findings: ["SANITIZER_INPUT_TOO_LARGE"], quarantineFindings: ["SANITIZER_INPUT_TOO_LARGE"] });
    // U+FDFA expands to 18 characters under NFKC: a schema-valid body grows past the cap.
    const expanding = String.fromCharCode(0xfdfa).repeat(MAX_BODY_CHARS);
    expect(expanding.normalize("NFKC").length).toBeGreaterThan(MAX_SANITIZE_INPUT_CHARS);
    expect(sanitizeKnowledgeText(expanding).quarantineFindings).toEqual(["SANITIZER_INPUT_TOO_LARGE"]);
    const ev = evaluateKnowledgeItem(knowledgeItemFixture({ sourceId: "kn02-expanding", body: expanding }), 0, { now: NOW, allowedLinkDomains: ALLOWED });
    expect(ev.kind).toBe("evaluated");
    if (ev.kind === "evaluated") {
      expect(ev.reasonCodes).toEqual(expect.arrayContaining(["KNOWLEDGE_SANITIZER_INPUT_TOO_LARGE", "KNOWLEDGE_EMPTY_AFTER_SANITIZE"]));
      expect(ev.reasonCodes).not.toContain("KNOWLEDGE_EXECUTABLE_CONTENT");
    }
    // At the schema maximum ordinary text is not refused.
    expect(sanitizeKnowledgeText("ok ".repeat(MAX_BODY_CHARS / 3)).quarantineFindings).toEqual([]);
  });

  // Round 2: the host/path scan was O(n^2). Every literal rescanned the shared path to the next delimiter,
  // and `[...]+$` trims rescanned long punctuation or slash runs from every start. Before the fix,
  // 'a.bc/' at 40 000 chars took about 164 ms, the combining-mark unit about 1 100 ms, a schema-valid
  // 20 000-char body that NFKC expands to 35 001 chars about 850 ms in evaluateKnowledgeItem, and a long
  // punctuation run after a host about 1.5 s. After the fix each takes about 1-15 ms.
  // The strict budget leaves room for slow shared runners and still fails every one of the old timings.
  const STRICT_BUDGET_MS = 100;
  /** Best of three runs (a run over `giveUpMs` cannot be a hiccup, so a regression fails quickly). */
  const bestOf3 = (fn: () => void, giveUpMs = 10 * STRICT_BUDGET_MS): number => {
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
  const ACUTE = String.fromCharCode(0x0301);

  it("[SPEC-14.threat-model][VSP-KN-02] 'a.bc/' and combining-mark host+path units at 20 000 and 40 000 chars sanitize within a strict budget", () => {
    for (const unit of ["a.bc/", `${ACUTE}a.bc/`, "a.bc:1/", "1.2.3.4/", "[::1]/", "a.bc/x", "a.bc-/", `a.b${ACUTE}c/`, "a..bc/"]) {
      for (const n of [20_000, 40_000]) {
        const input = repeatTo(unit, n);
        let r = sanitizeKnowledgeText("");
        const ms = bestOf3(() => {
          r = sanitizeKnowledgeText(input, { allowedLinkDomains: ALLOWED });
        });
        // The input must really be scanned (not refused by the input cap).
        expect(r.findings).not.toContain("SANITIZER_INPUT_TOO_LARGE");
        expect(r.findings).toContain("URL_REMOVED");
        expect({ unit, n, withinBudget: ms < STRICT_BUDGET_MS }).toEqual({ unit, n, withinBudget: true });
        expect(sanitizedTextViolations(r.text, ALLOWED)).toEqual([]);
      }
    }
  });

  it("[SPEC-14.threat-model][VSP-KN-02] long punctuation or slash runs inside a host, URL or allowlisted link path sanitize within a strict budget", () => {
    const ELLIPSIS = String.fromCharCode(0x2026); // NFKC "...": 13 300 of them expand to 39 900 dots.
    const inputs: Record<string, string> = {
      hostDots: `Visit a.bc/${ELLIPSIS.repeat(13_300)}x`,
      hostCommas: `Visit a.bc/${",".repeat(19_900)}x`,
      schemeUrl: `Visit http://x${ELLIPSIS.repeat(13_300)}x`,
      wwwHost: `Visit www.${ELLIPSIS.repeat(13_300)}x`,
      allowedSlashes: `Go to https://portal.synthetic-health.test${"/".repeat(19_000)}x now`,
      allowedBareSlashes: `Go to portal.synthetic-health.test${"/".repeat(19_000)}x now`,
    };
    for (const [name, input] of Object.entries(inputs)) {
      let r = sanitizeKnowledgeText("");
      const ms = bestOf3(() => {
        r = sanitizeKnowledgeText(input, { allowedLinkDomains: ALLOWED });
      });
      expect(r.findings).not.toContain("SANITIZER_INPUT_TOO_LARGE");
      expect({ name, withinBudget: ms < STRICT_BUDGET_MS }).toEqual({ name, withinBudget: true });
      expect(sanitizedTextViolations(r.text, ALLOWED)).toEqual([]);
    }
  });

  it("[SPEC-14.threat-model][VSP-KN-02] the ingestion evaluation of schema-valid bodies that NFKC-expands into host+path units finishes within a strict budget", () => {
    // U+2488 "1." + U+3386 "MB" + U+2100 "a/c": NFKC turns each unit into a dotted host with a path.
    for (const unit of [`${ACUTE}${String.fromCharCode(0x2488, 0x3386, 0x2100)}`, `${ACUTE}${String.fromCharCode(0x2488)}bc${String.fromCharCode(0x2100)}`, `${ACUTE}a.bc/`, "a.bc/"]) {
      const body = repeatTo(unit, MAX_BODY_CHARS);
      expect(body.normalize("NFKC").length).toBeLessThanOrEqual(MAX_SANITIZE_INPUT_CHARS);
      let ev = evaluateKnowledgeItem(knowledgeItemFixture({ sourceId: "kn02-host-path" }), 0, { now: NOW, allowedLinkDomains: ALLOWED });
      const ms = bestOf3(() => {
        ev = evaluateKnowledgeItem(knowledgeItemFixture({ sourceId: "kn02-host-path", body }), 0, { now: NOW, allowedLinkDomains: ALLOWED });
      });
      expect({ unit, withinBudget: ms < STRICT_BUDGET_MS }).toEqual({ unit, withinBudget: true });
      expect(ev.kind).toBe("evaluated");
      if (ev.kind === "evaluated") expect(ev.reasonCodes).not.toContain("KNOWLEDGE_SANITIZER_INPUT_TOO_LARGE");
    }
  });

  it("[SPEC-14.threat-model][VSP-KN-02] the ingestion evaluation of a schema-maximum '<a href=' body finishes within budget", () => {
    const started = performance.now();
    const ev = evaluateKnowledgeItem(knowledgeItemFixture({ sourceId: "kn02-anchors", body: repeatTo("<a href=", MAX_BODY_CHARS) }), 0, { now: NOW, allowedLinkDomains: ALLOWED });
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    expect(ev.kind).toBe("evaluated");
  });
});
