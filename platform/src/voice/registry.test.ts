import { describe, expect, it } from "vitest";
import { ConfigurationRejectedError } from "../shared/errors.js";
import {
  CLINICAL_REVIEW_MARKER,
  CatalogTemplateRegistry,
  LEGAL_REVIEW_MARKER,
  REQUIRED_PRODUCTION_TEMPLATE_IDS,
  TemplateCatalogError,
  assertCatalogDeployable,
  catalogDeploymentViolations,
  containsProhibitedClinicalContent,
  loadDefaultTemplateRegistry,
} from "./registry.js";
import enUS from "./templates/en-US.json" with { type: "json" };
import esUS from "./templates/es-US.json" with { type: "json" };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
type Catalog = typeof enUS;
const withTemplate = (cat: Catalog, id: string, patch: (t: Catalog["templates"][number]) => void): Catalog => {
  const c = clone(cat);
  const t = c.templates.find((x) => x.templateId === id);
  if (!t) throw new Error("test template missing");
  patch(t);
  return c;
};
const violationsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof TemplateCatalogError) return e.violations;
    throw e;
  }
  return [];
};

const REQUIRED_IDS = [
  "opening.disclosure",
  "recording.consent_question",
  "recording.decline_alternative",
  "disclosure.automated_processing",
  "intake.role_selection",
  "verification.secure_link_sent",
  "verification.otp_sent",
  "status.checking",
  "human.offer",
  "transfer.in_progress",
  "transfer.failed_next_route",
  "language.interpreter_route",
  "language.unsupported",
  "outage.continuity",
  "clinical.boundary",
  "safety.acknowledgment",
  "appointment.facts",
  "appointment.change_confirmation",
  "commitment.request_accepted",
  "invoice.balance",
  "invoice.line_explanation",
  "claim.status",
  "remittance.status",
  "onboarding.status",
  "policy.denied_generic",
  "verification.failed_generic",
  "support_reference.pending_sync",
  "repeat.on_request",
  "speech.slower",
  "fallback.safe_explanation",
];

describe("template catalog (LOCAL DRAFT)", () => {
  const registry = loadDefaultTemplateRegistry();

  it("[SPEC-11.templates] the bundled catalogs load for en-US and es-US with every required template in both locales", () => {
    expect(registry.locales()).toEqual(["en-US", "es-US"]);
    for (const locale of registry.locales()) for (const id of REQUIRED_IDS) expect(registry.get(id, locale), `${id}@${locale}`).not.toBeNull();
    expect(registry.catalogStatus).toBe("LOCAL_DRAFT");
  });

  it("[OPS-03] no template is APPROVED: safety/clinical are PENDING_CLINICAL_APPROVAL, recording/consent/disclosure PENDING_LEGAL_APPROVAL, others DRAFT", () => {
    for (const t of registry.list()) {
      expect(t.approval.approvedBy).toBeNull();
      if (t.responseClass === "SAFETY" || t.responseClass === "CLINICAL_BOUNDARY") {
        expect(t.approval.status).toBe("PENDING_CLINICAL_APPROVAL");
        expect(t.metadata.reviewMarker).toBe(CLINICAL_REVIEW_MARKER);
        expect(t.metadata.owner).toBe("clinical_safety_lead");
      } else if (t.responseClass === "RECORDING_DISCLOSURE") {
        expect(t.approval.status).toBe("PENDING_LEGAL_APPROVAL");
        expect(t.metadata.reviewMarker).toBe(LEGAL_REVIEW_MARKER);
      } else {
        expect(t.approval.status).toBe("DRAFT");
      }
      if (t.locale === "es-US") expect(t.metadata.languageReview).toBe("PENDING_NATIVE_SPEAKER_REVIEW");
    }
  });

  it("[SPEC-11.opening] the opening disclosure is the spec template with a companyName slot, followed by the consent flow", () => {
    const t = registry.get("opening.disclosure", "en-US");
    expect(t?.text).toBe(
      "You have reached {companyName}. I'm an automated support assistant. I can help with scheduling, billing, and account questions. You can ask for a person at any time.",
    );
    expect(t?.slots.companyName?.type).toBe("enum");
    expect(t?.metadata.notes).toMatch(/consent flow/);
    expect(registry.get("recording.decline_alternative", "en-US")?.text).not.toMatch(/not (be )?recorded|unrecorded/i);
  });

  it("[ACT-04] commitment and status templates never claim resolution; claim status is not a payment guarantee; invoices promise no refund", () => {
    for (const t of registry.list()) {
      if (t.responseClass === "COMMITMENT") expect(t.text).not.toMatch(/\b(resolved|is done|completed|resuelt[oa]|completad[oa]\b(?! ))/i);
      expect(t.text).not.toMatch(/refund|reembolso/i);
    }
    expect(registry.get("commitment.request_accepted", "en-US")?.text).toMatch(/isn't complete yet/);
    expect(registry.get("claim.status", "en-US")?.text).toMatch(/not a guarantee of payment/);
    expect(registry.get("claim.status", "es-US")?.text).toMatch(/No es una garantía de pago/);
    expect(registry.get("support_reference.pending_sync", "en-US")?.text).toMatch(/not a case number/);
    expect(registry.get("status.checking", "en-US")).toMatchObject({ text: "Let me check that.", responseClass: "GENERIC_STATUS", metadata: { acknowledgmentOnly: true } });
  });

  it("[SAFE-01] no template contains diagnostic, therapeutic, screening or medication advice, or invented feelings", () => {
    for (const t of registry.list()) expect(containsProhibitedClinicalContent(t.text), `${t.templateId}@${t.locale}`).toBe(false);
    expect(containsProhibitedClinicalContent("You may have depression.")).toBe(true);
    expect(containsProhibitedClinicalContent("Try a breathing exercise and stop taking your medication.")).toBe(true);
    expect(containsProhibitedClinicalContent("No se preocupe, todo va a estar bien.")).toBe(true);
  });

  it("[OPS-06] digest() is stable over the canonical catalog and changes when any template changes", () => {
    const again = loadDefaultTemplateRegistry();
    expect(again.digest()).toBe(registry.digest());
    expect(registry.digest()).toMatch(/^[a-f0-9]{64}$/);
    const changed = CatalogTemplateRegistry.fromCatalogs([withTemplate(enUS, "human.offer", (t) => (t.text = "Would you like a person?")), esUS]);
    expect(changed.digest()).not.toBe(registry.digest());
    // Order of templates in a file does not change the digest.
    const reordered = clone(enUS);
    reordered.templates.reverse();
    expect(CatalogTemplateRegistry.fromCatalogs([reordered, esUS]).digest()).toBe(registry.digest());
  });
});

describe("catalog validation fails closed", () => {
  it("[SPEC-11.templates] placeholders must match declared slots and braces must be valid", () => {
    expect(violationsOf(() => CatalogTemplateRegistry.fromCatalogs([withTemplate(enUS, "invoice.balance", (t) => (t.text = "Your balance is {amount} and {other}.")), esUS]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^PLACEHOLDER_UNDECLARED:invoice.balance@en-US:other/), expect.stringMatching(/^SLOT_UNUSED:invoice.balance@en-US:dueDate/)]),
    );
    expect(violationsOf(() => CatalogTemplateRegistry.fromCatalogs([withTemplate(enUS, "human.offer", (t) => (t.text = "Hello {Bad Slot}")), esUS]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^TEMPLATE_BRACES_INVALID/)]),
    );
  });

  it("[OPS-03] APPROVED requires an approval record id, and a pending template cannot name an approver", () => {
    expect(violationsOf(() => CatalogTemplateRegistry.fromCatalogs([withTemplate(enUS, "human.offer", (t) => (t.approval = { status: "APPROVED", approvedBy: null })), esUS]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^APPROVED_WITHOUT_APPROVAL_RECORD/)]),
    );
    expect(violationsOf(() => CatalogTemplateRegistry.fromCatalogs([withTemplate(enUS, "human.offer", (t) => ((t.approval as { approvedBy: string | null }).approvedBy = "apr_selfApproved01")), esUS]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^APPROVER_ON_UNAPPROVED_TEMPLATE/)]),
    );
  });

  it("[SAFE-01] safety and clinical templates must be clinically owned, marked pending clinical approval, short and slot-free", () => {
    const v = violationsOf(() =>
      CatalogTemplateRegistry.fromCatalogs([
        withTemplate(enUS, "safety.acknowledgment", (t) => {
          (t.approval as { status: string }).status = "DRAFT";
          t.metadata.reviewMarker = "[DRAFT]";
          t.text = `${"Please hold. ".repeat(20)}`;
        }),
        esUS,
      ]),
    );
    expect(v).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^CLINICAL_TEMPLATE_STATUS_INVALID:safety.acknowledgment/),
        expect.stringMatching(/^CLINICAL_REVIEW_MARKER_MISSING/),
        expect.stringMatching(/^SAFETY_TEMPLATE_TOO_LONG/),
      ]),
    );
  });

  it("[SAFE-01] a template with medication or diagnostic advice is rejected at load", () => {
    const v = violationsOf(() => CatalogTemplateRegistry.fromCatalogs([withTemplate(enUS, "clinical.boundary", (t) => (t.text = "It sounds like you have anxiety; you should take more pills.")), esUS]));
    expect(v).toEqual(expect.arrayContaining([expect.stringMatching(/^TEMPLATE_CLINICAL_ADVICE_PROHIBITED:clinical.boundary@en-US/)]));
  });

  it("[SPEC-11.templates] locales must stay in parity (ids, versions, classes, slot shapes)", () => {
    const missing = clone(esUS);
    missing.templates = missing.templates.filter((t) => t.templateId !== "human.offer");
    expect(violationsOf(() => CatalogTemplateRegistry.fromCatalogs([enUS, missing]))).toEqual(expect.arrayContaining(["LOCALE_PARITY_MISSING:human.offer"]));
    expect(violationsOf(() => CatalogTemplateRegistry.fromCatalogs([enUS, withTemplate(esUS, "human.offer", (t) => (t.version = "0.2.0-draft"))]))).toEqual(
      expect.arrayContaining(["LOCALE_PARITY_VERSION:human.offer"]),
    );
  });

  it("[SPEC-11.templates] unknown fields are rejected (strict schema)", () => {
    const extra = withTemplate(enUS, "human.offer", (t) => ((t as Record<string, unknown>).modelPrompt = "be warm"));
    expect(violationsOf(() => CatalogTemplateRegistry.fromCatalogs([extra, esUS])).some((x) => x.startsWith("CATALOG_SCHEMA_INVALID"))).toBe(true);
  });
});

describe("approval effectiveness and deployment checks", () => {
  const approve = (cat: Catalog, ids: readonly string[], approvalId: string): Catalog => {
    const c = clone(cat);
    for (const t of c.templates) {
      if (ids.includes(t.templateId)) (t as { approval: { status: string; approvedBy: string | null } }).approval = { status: "APPROVED", approvedBy: approvalId };
    }
    return c;
  };

  it("[OPS-04] production refuses to start with the LOCAL DRAFT catalog (required templates unapproved)", () => {
    const registry = loadDefaultTemplateRegistry();
    expect(catalogDeploymentViolations(registry, "local")).toEqual([]);
    const v = catalogDeploymentViolations(registry, "production");
    expect(v).toContain("REQUIRED_TEMPLATE_NOT_APPROVED:safety.acknowledgment@en-US");
    expect(v).toContain("REQUIRED_TEMPLATE_NOT_APPROVED:fallback.safe_explanation@es-US");
    expect(() => assertCatalogDeployable(registry, "production")).toThrow(ConfigurationRejectedError);
  });

  it("[OPS-04] an APPROVED status counts only when its approval record id was verified by the approvals loader", () => {
    const approvalId = "apr_synthNotARealApproval1";
    const cats = [approve(enUS, REQUIRED_PRODUCTION_TEMPLATE_IDS, approvalId), approve(esUS, REQUIRED_PRODUCTION_TEMPLATE_IDS, approvalId)];
    const unverified = CatalogTemplateRegistry.fromCatalogs(cats);
    const t = unverified.get("safety.acknowledgment", "en-US");
    expect(t && unverified.effectiveApproval(t)).toBe("APPROVAL_UNVERIFIED");
    expect(catalogDeploymentViolations(unverified, "production").length).toBeGreaterThan(0);
    const verified = CatalogTemplateRegistry.fromCatalogs(cats, { verifiedApprovalIds: new Set([approvalId]) });
    expect(catalogDeploymentViolations(verified, "production")).toEqual([]);
  });
});
