import { describe, expect, it } from "vitest";
import { ArtifactKind, classifyArtifact } from "./classification.js";
import type { ArtifactDescriptor } from "./classification.js";

describe("classifyArtifact", () => {
  it("[DATA-02] raw audio is PHI_RESTRICTED / RESTRICTED_QA_MEDIA regardless of any redaction status or derivative", () => {
    for (const redactionStatus of [undefined, "NOT_ATTEMPTED", "REDACTED", "FAILED", "QUARANTINED"] as const) {
      const c = classifyArtifact({ kind: "RAW_AUDIO", ...(redactionStatus ? { redactionStatus } : {}), claimsDeidentified: true });
      expect(c).toMatchObject({ classification: "PHI_RESTRICTED", dataClass: "RESTRICTED_QA_MEDIA", phiBearing: true });
      expect(c.handling).toMatchObject({ generalLogs: false, unapprovedAnalytics: false, debuggingVendors: false, publicOrLongLivedLinks: false, restrictedStore: true, modelContext: "FORBIDDEN" });
      expect(c.reasonCodes).toEqual(expect.arrayContaining(["RAW_AUDIO_ALWAYS_RESTRICTED", "DEIDENTIFICATION_NOT_ESTABLISHED"]));
    }
  });

  it("[DATA-02] the pre-redaction transcript stays restricted even after a redacted derivative exists", () => {
    const redacted = classifyArtifact({ kind: "REDACTED_TRANSCRIPT", redactionStatus: "REDACTED", derivedFrom: ["PRE_REDACTION_TRANSCRIPT", "RAW_AUDIO"] });
    expect(redacted.classification).toBe("PHI");
    const original = classifyArtifact({ kind: "PRE_REDACTION_TRANSCRIPT" });
    expect(original).toMatchObject({ classification: "PHI_RESTRICTED", dataClass: "RESTRICTED_QA_MEDIA" });
  });

  it("[DATA-02] a redacted transcript remains PHI-bearing; a claimed de-identification is ignored", () => {
    const c = classifyArtifact({ kind: "REDACTED_TRANSCRIPT", redactionStatus: "REDACTED", claimsDeidentified: true });
    expect(c).toMatchObject({ classification: "PHI", phiBearing: true, quarantined: false, dataClass: "TRANSIENT_CONVERSATION" });
    expect(c.handling.unapprovedAnalytics).toBe(false);
    expect(c.handling.modelContext).toBe("MINIMIZED_APPROVED_ENDPOINT_ONLY");
    expect(c.reasonCodes).toEqual(expect.arrayContaining(["REDACTION_IS_NOT_DEIDENTIFICATION", "DEIDENTIFICATION_NOT_ESTABLISHED"]));
  });

  it("[DATA-02] failed, quarantined or unattempted redaction is treated as the restricted original and quarantined", () => {
    for (const redactionStatus of ["FAILED", "QUARANTINED", "NOT_ATTEMPTED"] as const) {
      const c = classifyArtifact({ kind: "REDACTED_TRANSCRIPT", redactionStatus });
      expect(c).toMatchObject({ classification: "PHI_RESTRICTED", dataClass: "RESTRICTED_QA_MEDIA", quarantined: true });
    }
  });

  it("[SPEC-6.data-classes] the four data classes are assigned by artifact kind", () => {
    expect(classifyArtifact({ kind: "CALL_SUMMARY" }).dataClass).toBe("BUSINESS_RECORD");
    expect(classifyArtifact({ kind: "SUPPORT_MEMORY_ENTRY" }).classification).toBe("PHI");
    expect(classifyArtifact({ kind: "AUDIT_EVENT" })).toMatchObject({ classification: "INTERNAL", dataClass: "SECURITY_AUDIT" });
    expect(classifyArtifact({ kind: "VERIFICATION_SECRET" })).toMatchObject({ classification: "VERIFICATION_SECRET", dataClass: null });
    expect(classifyArtifact({ kind: "VERIFICATION_SECRET" }).handling.persist).toBe(false);
    expect(classifyArtifact({ kind: "KNOWLEDGE_ARTICLE", knowledgeSensitivity: "PUBLIC" }).classification).toBe("PUBLIC");
    expect(classifyArtifact({ kind: "KNOWLEDGE_ARTICLE" }).classification).toBe("INTERNAL");
  });

  it("[DATA-02] derivation never lowers sensitivity", () => {
    const knowledgeFromTranscript = classifyArtifact({ kind: "KNOWLEDGE_ARTICLE", knowledgeSensitivity: "PUBLIC", derivedFrom: ["PRE_REDACTION_TRANSCRIPT"] });
    expect(knowledgeFromTranscript).toMatchObject({ classification: "PHI", phiBearing: true });
    expect(knowledgeFromTranscript.reasonCodes).toContain("DERIVED_FROM_PHI_SOURCE");
    const telemetry = classifyArtifact({ kind: "CONTENT_FREE_TELEMETRY", derivedFrom: ["RAW_AUDIO"] });
    expect(telemetry.reasonCodes).toContain("TELEMETRY_FROM_PHI_SOURCE_REQUIRES_CONTENT_FREE_CHECK");
    const fromSecret = classifyArtifact({ kind: "BUSINESS_RECORD", derivedFrom: ["VERIFICATION_SECRET"] });
    expect(fromSecret.classification).toBe("VERIFICATION_SECRET");
  });

  it("[SPEC-6.data-classes] every artifact kind classifies and unknown descriptors fail closed", () => {
    for (const kind of ArtifactKind.options) expect(() => classifyArtifact({ kind })).not.toThrow();
    expect(() => classifyArtifact({ kind: "RAW_AUDIO", extra: true } as unknown as ArtifactDescriptor)).toThrow();
    expect(() => classifyArtifact({ kind: "SCREENSHOT" } as unknown as ArtifactDescriptor)).toThrow();
  });
});
