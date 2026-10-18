import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PEOPLE } from "../fixtures/synthetic-world.js";
import { createMemoryLogger } from "../observability/logger.js";
import { InMemoryMetrics, createMetricCatalogue } from "../observability/metrics.js";
import { FakeClock } from "../shared/clock.js";
import { EgressGuard } from "./egress.js";
import type { EgressPolicyConfig } from "./egress.js";
import { detectSensitiveSpans, luhnValid } from "./patterns.js";
import { assessResidualRisk, redactText } from "./redaction.js";
import { InMemoryQuarantineStoreFixture, RedactionService } from "./redaction-service.js";

// SYNTHETIC values only: 555-01xx fictional phone range, reserved example domains,
// SSN-shaped numbers in the never-issued 9xx area, and well-known test card numbers.
const TEST_KEY = "TEST-ONLY-synthetic-tokenization-key";

describe("redactText", () => {
  it("[SPEC-6.redaction] tokenizes phones, emails, dates, digit runs, SSN-like and card-like values and supplied names", () => {
    const text =
      `Hi this is about ${PEOPLE.avery.fullName}'s bill. Call me at (555) 010-0101 or +15555550102, ` +
      "email avery.synthetic@example.test. Born 1990-01-01, appointment on October 22. " +
      "Account 98765432 and SSN 912-34-5678 and card 4111 1111 1111 1111.";
    const r = redactText(text, { names: [PEOPLE.avery.fullName], tokenKey: TEST_KEY, minConfidence: 0 });
    expect(r.status).toBe("REDACTED");
    if (r.status !== "REDACTED") return;
    const out = r.redacted;
    for (const leaked of ["Avery", "Synthetic-Client", "010-0101", "5555550102", "avery.synthetic", "1990-01-01", "October 22", "98765432", "912-34-5678", "4111"]) {
      expect(out).not.toContain(leaked);
    }
    const types = r.tokens.map((t) => t.type).sort();
    expect(types).toEqual(expect.arrayContaining(["CARD", "DATE", "DIGITS", "EMAIL", "NAME", "PHONE", "SSN"]));
    expect(r.deidentified).toBe(false);
    expect(r.probabilistic).toBe(true);
    // Tokens never carry the original value; digests are keyed HMACs.
    for (const t of r.tokens) {
      expect(Object.keys(t).sort()).toEqual(["occurrences", "placeholder", "type", "valueDigest"]);
      expect(t.valueDigest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("[SPEC-6.redaction] equal values share one placeholder and digest; no key means null digests", () => {
    const r = redactText("Call 555-010-0101, again 555.010.0101 please", { tokenKey: TEST_KEY });
    expect(r.status).toBe("REDACTED");
    if (r.status !== "REDACTED") return;
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0]).toMatchObject({ placeholder: "[PHONE_1]", occurrences: 2 });
    expect(r.redacted).toBe("Call [PHONE_1], again [PHONE_1] please");
    const noKey = redactText("Call 555-010-0101", {});
    expect(noKey.status === "REDACTED" && noKey.tokens[0]?.valueDigest).toBeNull();
  });

  it("[SPEC-6.redaction] spoken digits, spoken emails and spaced digits from ASR are tokenized", () => {
    const r = redactText("my number is five five five zero one zero one and email avery at example dot test, code 4 7 2 9", { minConfidence: 0 });
    expect(r.status).toBe("REDACTED");
    if (r.status !== "REDACTED") return;
    expect(r.redacted).not.toMatch(/five five five/);
    expect(r.redacted).not.toMatch(/example dot test/);
    expect(r.redacted).not.toMatch(/4 7 2 9/);
  });

  it("[DATA-02] redaction failure quarantines: invalid input, oversized input, invalid context", () => {
    expect(redactText(42 as unknown as string)).toMatchObject({ status: "QUARANTINED", redacted: null, reasonCodes: ["REDACTION_INPUT_INVALID"] });
    expect(redactText("x".repeat(20), { maxInputChars: 10 })).toMatchObject({ status: "QUARANTINED", redacted: null, reasonCodes: ["REDACTION_INPUT_TOO_LARGE"] });
    expect(redactText("hello", { names: [42 as unknown as string] })).toMatchObject({ status: "QUARANTINED", reasonCodes: ["REDACTION_CONTEXT_INVALID"] });
    expect(redactText("hello", { minConfidence: 2 })).toMatchObject({ status: "QUARANTINED", reasonCodes: ["REDACTION_CONTEXT_INVALID"] });
  });

  it("[DATA-02] residual risk (unlisted name, identifier cue with a value) lowers confidence and quarantines", () => {
    const unlisted = redactText("Hello, my name is Jordan and I need help with my bill");
    expect(unlisted.status).toBe("QUARANTINED");
    expect(unlisted.redacted).toBeNull();
    expect(unlisted.reasonCodes).toEqual(expect.arrayContaining(["REDACTION_LOW_CONFIDENCE", "RESIDUAL_POSSIBLE_UNLISTED_NAME"]));
    const cue = redactText("my date of birth is nineteen ninety, the last four are 1 2 3");
    expect(cue.status).toBe("QUARANTINED");
    expect(cue.reasonCodes).toContain("RESIDUAL_IDENTIFIER_CUE_WITH_VALUE");
    // The same text redacts when the name is supplied from trusted context.
    const listed = redactText("Hello, my name is Jordan and I need help with my bill", { names: ["Jordan"] });
    expect(listed.status).toBe("REDACTED");
  });

  it("[SPEC-6.redaction] benign administrative text passes with full confidence", () => {
    const r = redactText("I would like to reschedule my appointment and ask about the late cancellation fee.");
    expect(r).toMatchObject({ status: "REDACTED", confidence: 1, tokens: [] });
    expect(assessResidualRisk("All good here").confidence).toBe(1);
  });

  it("[SPEC-6.redaction] property: generated synthetic identifiers never survive in a REDACTED result", () => {
    const phone = fc.tuple(fc.integer({ min: 200, max: 999 }), fc.integer({ min: 100, max: 999 }), fc.integer({ min: 0, max: 9999 })).map(
      ([a, b, c]) => `${a}-${b}-${String(c).padStart(4, "0")}`,
    );
    const email = fc.tuple(fc.stringMatching(/^[a-z]{3,10}$/), fc.constantFrom("example.test", "example.invalid")).map(([u, d]) => `${u}@${d}`);
    const ssn = fc.tuple(fc.integer({ min: 900, max: 999 }), fc.integer({ min: 10, max: 99 }), fc.integer({ min: 1000, max: 9999 })).map(([a, b, c]) => `${a}-${b}-${c}`);
    const filler = fc.constantFrom("please help", "about my bill", "thanks", "reschedule", "", "the portal", "and");
    fc.assert(
      fc.property(fc.array(fc.oneof(phone, email, ssn, filler), { minLength: 1, maxLength: 8 }), (parts) => {
        const text = parts.join(" ");
        const r = redactText(text, { minConfidence: 0 });
        if (r.status === "QUARANTINED") return r.redacted === null;
        for (const p of parts) if (/\d{3}-|@/.test(p)) expect(r.redacted).not.toContain(p);
        return true;
      }),
      { numRuns: 300, seed: 20261017 },
    );
  });
});

describe("pattern detectors", () => {
  it("[SPEC-6.redaction] Luhn distinguishes card-like numbers from other long digit runs", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    const spans = detectSensitiveSpans("card 4111111111111111 other 1234567890123");
    expect(spans.map((s) => s.type)).toEqual(["CARD", "DIGITS"]);
  });

  it("[SPEC-6.redaction] dates in several shapes are detected; years and amounts alone are not", () => {
    const types = (t: string) => detectSensitiveSpans(t).map((s) => s.type);
    expect(types("on 2026-10-22")).toEqual(["DATE"]);
    expect(types("on 10/22/2026")).toEqual(["DATE"]);
    expect(types("on Jan 5th, 1990")).toEqual(["DATE"]);
    expect(types("on 5 January 1990")).toEqual(["DATE"]);
    expect(types("in 2026 we billed 1250 dollars")).toEqual([]);
  });
});

describe("RedactionService", () => {
  const policy: EgressPolicyConfig = {
    policyVersion: "egress-test.1",
    destinations: [
      {
        destinationId: "egr_quarantine_store",
        kind: "RESTRICTED_MEDIA_STORE",
        hosts: ["quarantine.local.invalid"],
        allowedClasses: ["PHI", "PHI_RESTRICTED"],
        coverage: { baaRef: "TEST-ONLY-BAA-REF", approvalId: "apr_testOnlyQuarantine1" },
        environments: ["local", "ci"],
        adapterKind: "local_fixture",
      },
      {
        destinationId: "egr_debug_vendor",
        kind: "DEBUGGING_VENDOR",
        hosts: ["debug.vendor.invalid"],
        allowedClasses: ["PUBLIC", "INTERNAL"],
        coverage: { baaRef: null, approvalId: null },
        environments: ["local", "ci"],
        adapterKind: "local_fixture",
      },
    ],
  };

  it("[DATA-02] redaction failure quarantines the artifact into the approved restricted store, never a debugging vendor", async () => {
    const egress = new EgressGuard(policy, { environment: "local" });
    const store = new InMemoryQuarantineStoreFixture("egr_quarantine_store");
    const { logger, records } = createMemoryLogger();
    const svc = new RedactionService({ quarantine: store, egress, logger, clock: new FakeClock() });
    const raw = "my name is Jordan, my date of birth is 1 2 3";
    const out = await svc.process({ artifactId: "art_synthArtifact000001", text: raw });
    expect(out.result.status).toBe("QUARANTINED");
    expect(out.result.redacted).toBeNull();
    expect(out.classification).toMatchObject({ classification: "PHI_RESTRICTED", dataClass: "RESTRICTED_QA_MEDIA", quarantined: true });
    expect(out.quarantine).toMatchObject({ stored: true });
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({ artifactId: "art_synthArtifact000001", classification: "PHI_RESTRICTED", quarantinedAt: "2026-10-17T15:00:00.000Z" });
    // Logs carry codes and opaque ids only.
    expect(JSON.stringify(records)).not.toContain("Jordan");
    // A debugging vendor can never receive the restricted artifact.
    expect(egress.check({ destinationId: "egr_debug_vendor" }, "PHI_RESTRICTED")).toMatchObject({ allowed: false, reasonCode: "EGRESS_PHI_TO_CONTENT_FREE_DESTINATION" });
  });

  it("[DATA-01] an unapproved quarantine store receives nothing", async () => {
    const egress = new EgressGuard(policy, { environment: "local" });
    const store = new InMemoryQuarantineStoreFixture("egr_debug_vendor");
    const svc = new RedactionService({ quarantine: store, egress });
    const out = await svc.process({ artifactId: "art_synthArtifact000002", text: "my name is Jordan" });
    expect(out.quarantine).toMatchObject({ stored: false, reasonCode: "QUARANTINE_STORE_NOT_APPROVED" });
    expect(store.records).toHaveLength(0);
  });

  it("[SPEC-13.metrics][DATA-02] redaction outcomes are counted (vsp_redaction_results_total: redacted | quarantined)", async () => {
    const metrics = new InMemoryMetrics({ catalogue: createMetricCatalogue({ toolNames: [] }) });
    const egress = new EgressGuard(policy, { environment: "local" });
    const svc = new RedactionService({ quarantine: new InMemoryQuarantineStoreFixture("egr_quarantine_store"), egress, clock: new FakeClock(), metrics });
    await svc.process({ artifactId: "art_synthArtifactMetric1", text: "my name is Jordan, my date of birth is 1 2 3" });
    await svc.process({ artifactId: "art_synthArtifactMetric2", text: "I would like to reschedule my appointment please" });
    expect(metrics.counterValue("vsp_redaction_results_total", { result: "quarantined" })).toBe(1);
    expect(metrics.counterValue("vsp_redaction_results_total", { result: "redacted" })).toBe(1);
  });

  it("[DATA-02] a successful redaction stays PHI-bearing (not de-identified)", async () => {
    const egress = new EgressGuard(policy, { environment: "local" });
    const svc = new RedactionService({ quarantine: new InMemoryQuarantineStoreFixture("egr_quarantine_store"), egress });
    const out = await svc.process({ artifactId: "art_synthArtifact000003", text: "Please call 555-010-0101 about rescheduling" });
    expect(out.result.status).toBe("REDACTED");
    expect(out.classification).toMatchObject({ classification: "PHI", phiBearing: true });
    expect(out.classification.reasonCodes).toContain("REDACTION_IS_NOT_DEIDENTIFICATION");
  });
});
