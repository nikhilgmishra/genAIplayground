/**
 * AUTH-03 at the contract boundary (WP-02 invariant obligation): actor, subject, organization,
 * assurance and consent are server-established. The follow-on contracts that carry untrusted
 * proposals (ModelDecision.arguments, ToolRequestV2.arguments) refuse every server-established or
 * trusted envelope field at any depth, and the trusted contracts (CallBinding, AuthContext) accept
 * those fields only from trusted sources.
 *
 * Positive, direct adversarial and failure-injection cases; in-memory zod validation of the real
 * contract schemas; SYNTHETIC values only.
 */
import { describe, expect, it } from "vitest";
import { AuthContext } from "./auth.js";
import { CallBinding } from "./call-binding.js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROPOSAL_FORBIDDEN_CONCEPTS,
  PROPOSAL_FORBIDDEN_FIELDS,
  PROPOSAL_KEY_EXEMPTIONS,
  PROTOTYPE_KEYS,
  SERVER_ESTABLISHED_FIELDS,
  fieldNameWords,
  findForbiddenProposalField,
  isForbiddenProposalKey,
  normalizeFieldName,
  safeParseUntrusted,
} from "./common.js";
import { ModelDecision, ProposedArguments } from "./models.js";
import { BoundedToolArguments, ToolRequestV2 } from "./tool-envelope.js";
import * as F from "./fixtures/contracts.fixture.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }): string => (r.success ? "" : (r.error?.issues ?? []).map((i) => i.message).join("\n"));

describe("[AUTH-03] server-established fields at the contract boundary", () => {
  it("[AUTH-03] positive: a model proposal with ordinary tool arguments parses, and trusted contracts carry the server-established fields", () => {
    expect(ModelDecision.safeParse(F.modelDecision({ appointmentId: "apt_synthAveryAppt000001", modality: "video" })).success).toBe(true);
    expect(ToolRequestV2.safeParse(F.toolRequestV2({ slotId: "slt_synthSlot0000000001" })).success).toBe(true);
    const binding = CallBinding.parse(F.callBinding());
    expect(binding.tenantId).toBe(F.SYNTH.tenantId);
    expect(binding.boundBy).toBe("carrier_dispatch_rule");
    expect(Object.keys(AuthContext.shape)).toEqual(expect.arrayContaining([...SERVER_ESTABLISHED_FIELDS.filter((f) => f !== "consent" && f !== "callId"), "consent", "callId"]));
  });

  it("[AUTH-03] adversarial: every server-established field proposed by a model or tool argument is refused", () => {
    for (const field of PROPOSAL_FORBIDDEN_FIELDS) {
      const decision = ModelDecision.safeParse(F.modelDecision({ appointmentId: "apt_synthAveryAppt000001", [field]: "A3" }));
      expect(decision.success, `ModelDecision ${field}`).toBe(false);
      expect(messages(decision), field).toContain(`SERVER_ESTABLISHED_FIELD_IN_PROPOSAL:${field}`);
      const request = ToolRequestV2.safeParse(F.toolRequestV2({ [field]: "act_synthAttacker000001" }));
      expect(request.success, `ToolRequestV2 ${field}`).toBe(false);
    }
  });

  it("[AUTH-03] adversarial: a server-established field in another spelling (snake_case, PascalCase, upper case, kebab-case) is refused", () => {
    const toSnake = (f: string): string => f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    for (const field of PROPOSAL_FORBIDDEN_FIELDS) {
      const variants = [toSnake(field), field[0]!.toUpperCase() + field.slice(1), field.toUpperCase(), toSnake(field).toUpperCase(), toSnake(field).replace(/_/g, "-")];
      for (const v of variants) {
        expect(isForbiddenProposalKey(v), v).toBe(true);
        expect(findForbiddenProposalField({ appointmentId: "apt_synthAveryAppt000001", [v]: "A3" }), v).toBe(v);
        // Keys the proposal key grammar accepts reach the scan through the real contract.
        if (/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(v)) {
          const decision = ModelDecision.safeParse(F.modelDecision({ appointmentId: "apt_synthAveryAppt000001", [v]: "A3" }));
          expect(decision.success, `ModelDecision ${v}`).toBe(false);
          expect(messages(decision), v).toContain(`SERVER_ESTABLISHED_FIELD_IN_PROPOSAL:${v}`);
          expect(ToolRequestV2.safeParse(F.toolRequestV2({ [v]: "act_synthAttacker000001" })).success, `ToolRequestV2 ${v}`).toBe(false);
        }
      }
    }
    // The prompt's own snake_case spellings and the probes that previously passed.
    for (const v of ["tenant_id", "TenantId", "subject_id", "selected_role", "Assurance", "actor_id", "session_generation", "interaction_id", "causation_id", "schema_version"]) {
      expect(ModelDecision.safeParse(F.modelDecision({ appointmentId: "apt_synthAveryAppt000001", [v]: "A3" })).success, v).toBe(false);
    }
    expect(findForbiddenProposalField({ filter: { Owner: { Subject_Id: "sub_synthClientBlake01" } } })).toBe("filter.Owner.Subject_Id");
    // Normalization does not over-block: ordinary argument names stay allowed (the whole tool
    // catalogue is checked below). A tenant name or a consent template is NOT ordinary: the tenant
    // and the consent wording are server-established, so a proposal naming them is refused.
    for (const ok of ["appointmentId", "slotId", "modality", "invoiceLineId", "reasonCode"]) expect(isForbiddenProposalKey(ok), ok).toBe(false);
    for (const no of ["tenantName", "consentTemplateId"]) expect(isForbiddenProposalKey(no), no).toBe(true);
    expect(normalizeFieldName("Session-Generation")).toBe("sessiongeneration");
  });

  it("[AUTH-03] adversarial (verifier probe P4): a key that names an identity, authority or consent concept without the exact field name is refused", () => {
    const probes = ["role", "actor", "subject", "organization", "tenant", "consentRecording", "consent_automated_processing", "scopes", "delegation", "verified", "authenticated"];
    const more = ["callerRole", "roles_granted", "isVerified", "SubjectIdentifier", "orgId", "userId", "principal", "impersonateAs", "grantRef", "permissions", "riskLevel", "legalBasis", "dataClass_classification", "recordingconsent", "consentrecording", "tenantname", "unverified", "subject2"];
    for (const key of [...probes, ...more]) {
      expect(isForbiddenProposalKey(key), key).toBe(true);
      const decision = ModelDecision.safeParse(F.modelDecision({ appointmentId: "apt_synthAveryAppt000001", [key]: "x" }));
      expect(decision.success, `ModelDecision ${key}`).toBe(false);
      expect(messages(decision), key).toContain(`SERVER_ESTABLISHED_FIELD_IN_PROPOSAL:${key}`);
      expect(ToolRequestV2.safeParse(F.toolRequestV2({ slotId: "slt_synthSlot0000000001", [key]: "x" })).success, `ToolRequestV2 ${key}`).toBe(false);
    }
    expect(findForbiddenProposalField({ filter: [{ who: { Consent_Recording: "GRANTED" } }] })).toBe("filter[0].who.Consent_Recording");
  });

  it("[AUTH-03] every concept word is refused alone, inside a longer key and glued in lower case; the documented exclusions are ordinary words", () => {
    // Independent of the source list on purpose: dropping a concept from PROPOSAL_FORBIDDEN_CONCEPTS fails here.
    const concepts = [
      "tenant", "call", "calls", "actor", "subject", "organization", "organisation", "org", "orgs", "role", "assurance", "consent", "scope", "delegate", "delegation",
      "authority", "authorities", "authentication", "authenticated", "authorization", "authorisation", "authorized", "authorised", "verification", "verified",
      "identity", "identities", "principal", "user", "impersonate", "impersonation", "permission", "entitlement", "grant", "session", "generation", "risk",
      "revoked", "revocation", "interaction", "causation", "classification", "basis",
    ];
    expect([...PROPOSAL_FORBIDDEN_CONCEPTS].sort()).toEqual([...concepts].sort());
    for (const w of concepts) {
      for (const key of [w, `my_${w}_value`, `the${w[0]!.toUpperCase()}${w.slice(1)}Value`]) expect(isForbiddenProposalKey(key), key).toBe(true);
    }
    // Plural and participle forms reach the concept as a word prefix; glued lower-case forms as prefix or suffix.
    for (const key of ["roles", "scoped", "delegated", "sessions", "tenants", "consented", "subjectref", "callerrole", "nonconsent"]) expect(isForbiddenProposalKey(key), key).toBe(true);
    // Each exclusion keeps one ordinary word allowed (prefix exclusions: call, org; suffix exclusions: the rest).
    for (const ok of ["callback", "organic", "recall", "cyborg", "factor", "telescope", "possession", "regeneration", "immigrant", "asterisk", "superuser"]) {
      expect(isForbiddenProposalKey(ok), ok).toBe(false);
    }
    expect(fieldNameWords("XMLHttpSubjectID_2nd-value")).toEqual(["xml", "http", "subject", "id", "2", "nd", "value"]);
  });

  it("[AUTH-03] the forbidden set is tied to the contracts: every identity, authority and consent field of AuthContext and every trusted envelope field is refused and documented", () => {
    // Independent list (not derived from PROPOSAL_FORBIDDEN_FIELDS): removing a field from the documented list fails here.
    const trustedFields = [
      "tenantId", "callId", "sessionRef", "sessionGeneration", "actorId", "selectedRole", "subjectId", "organizationId", "delegatedAuthority", "permittedScopes",
      "assurance", "authenticatedAt", "verificationMethod", "consent", "riskFlags", "policyVersion", "revoked", "stepUp", "integration", "processingBasis",
      "consentProfile", "dataClassification", "schemaVersion", "actorRef", "subjectRef", "interactionId", "causationId",
    ];
    expect([...PROPOSAL_FORBIDDEN_FIELDS]).toEqual(expect.arrayContaining(trustedFields));
    // Every AuthContext field is in that list except its hard expiry, which states no identity or authority.
    const reviewedNonIdentity = ["expiresAt"];
    expect(Object.keys(AuthContext.shape).filter((k) => !reviewedNonIdentity.includes(k)).sort()).toEqual(trustedFields.filter((f) => f in AuthContext.shape).sort());
    for (const f of [...trustedFields, ...PROTOTYPE_KEYS]) {
      expect(isForbiddenProposalKey(f), f).toBe(true);
      if (/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(f)) {
        expect(ModelDecision.safeParse(F.modelDecision({ appointmentId: "apt_synthAveryAppt000001", [f]: "x" })).success, f).toBe(false);
        expect(ToolRequestV2.safeParse(F.toolRequestV2({ slotId: "slt_synthSlot0000000001", [f]: "x" })).success, f).toBe(false);
      }
    }
  });

  it("[AUTH-03][SAFE-02] positive: every argument name of the tool catalogue passes the scan; concernSubject passes only with the safety tool's enumerated values", () => {
    const catalog = JSON.parse(readFileSync(join(repoRoot, "schemas/tools/catalog.json"), "utf8")) as { definitions: { name: string; inputSchema: unknown }[] };
    const names = new Set<string>();
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (typeof n !== "object" || n === null) return;
      const o = n as Record<string, unknown>;
      if (o.properties && typeof o.properties === "object") {
        for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
          names.add(k);
          walk(v);
        }
      }
      for (const [k, v] of Object.entries(o)) if (k !== "properties") walk(v);
    };
    for (const t of catalog.definitions) walk(t.inputSchema);
    expect(names.size).toBeGreaterThan(30);
    const blocked = [...names].filter((k) => isForbiddenProposalKey(k) && !(k in PROPOSAL_KEY_EXEMPTIONS));
    expect(blocked, "catalogue arguments refused by the AUTH-03 scan").toEqual([]);
    const safety = catalog.definitions.find((t) => t.name === "request_safety_route");
    const concern = (safety?.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.concernSubject;
    expect(concern?.enum).toEqual([...(PROPOSAL_KEY_EXEMPTIONS.concernSubject ?? [])]);
    for (const v of concern?.enum ?? []) {
      expect(findForbiddenProposalField({ signalSource: "CALLER_REQUEST", concernSubject: v, language: "en" }), v).toBeNull();
      expect(ModelDecision.safeParse(F.modelDecision({ signalSource: "CALLER_REQUEST", concernSubject: v, language: "en" })).success, v).toBe(true);
    }
    for (const bad of ["sub_synthClientBlake01", "self", { subjectId: "sub_synthClientBlake01" }, ["SELF"]]) {
      expect(findForbiddenProposalField({ concernSubject: bad }), JSON.stringify(bad)).toBe("concernSubject");
    }
    expect(findForbiddenProposalField({ concernSubjectRef: "SELF" })).toBe("concernSubjectRef");
  });

  it("[AUTH-03] adversarial: a nested or array-wrapped identity field is found at any depth", () => {
    const nested = { filter: { owner: { subjectId: "sub_synthClientBlake01" } } };
    expect(findForbiddenProposalField(nested)).toBe("filter.owner.subjectId");
    expect(messages(ModelDecision.safeParse(F.modelDecision(nested)))).toContain("SERVER_ESTABLISHED_FIELD_IN_PROPOSAL:filter.owner.subjectId");
    const inArray = { items: [{ ok: 1 }, { assurance: "A3" }] };
    expect(findForbiddenProposalField(inArray)).toBe("items[1].assurance");
    expect(ToolRequestV2.safeParse(F.toolRequestV2(inArray)).success).toBe(false);
  });

  it("[AUTH-03] adversarial: a carrier binding cannot be established by a model, a caller-supplied number or an untrusted source", () => {
    expect(CallBinding.safeParse({ ...F.callBinding(), boundBy: "model" }).success).toBe(false);
    expect(CallBinding.safeParse({ ...F.callBinding(), boundBy: "tool_argument" }).success).toBe(false);
    expect(CallBinding.safeParse({ ...F.callBinding(), carrier: { ...F.callBinding().carrier, interactionRef: "+15555550101" } }).success).toBe(false);
    expect(CallBinding.safeParse({ ...F.callBinding(), selectedRole: "provider" }).success).toBe(false);
  });

  it("[AUTH-03] failure injection: prototype-pollution keys from JSON, a depth bomb, an oversized payload and a non-JSON value are refused, never thrown or merged", () => {
    const polluted = JSON.parse('{"appointmentId":"apt_synthAveryAppt000001","__proto__":{"assurance":"A3"}}') as Record<string, unknown>;
    expect(findForbiddenProposalField(polluted)).toBe("__proto__");
    expect(safeParseUntrusted(ProposedArguments, polluted)).toEqual({ success: false, reasonCode: "SERVER_ESTABLISHED_FIELD_IN_PROPOSAL:__proto__" });
    // The contract itself refuses it: the key scan runs on the raw value before zod parses the record
    // (zod would otherwise drop the own __proto__ key silently).
    const direct = ModelDecision.safeParse(F.modelDecision(polluted));
    expect(direct.success).toBe(false);
    expect(messages(direct)).toContain("SERVER_ESTABLISHED_FIELD_IN_PROPOSAL:__proto__");
    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);
    const pollutedRequest = ToolRequestV2.safeParse(F.toolRequestV2(JSON.parse('{"slotId":"slt_synthSlot0000000001","__proto__":{"tenantId":"ten_attackerAttacker01"}}') as Record<string, unknown>));
    expect(pollutedRequest.success).toBe(false);
    expect(messages(pollutedRequest)).toContain("SERVER_ESTABLISHED_FIELD_IN_ARGUMENTS:__proto__");
    expect(ToolRequestV2.safeParse(F.toolRequestV2(JSON.parse('{"constructor":{"prototype":{"tenantId":"x"}}}') as Record<string, unknown>)).success).toBe(false);
    expect(safeParseUntrusted(BoundedToolArguments, { slotId: "slt_synthSlot0000000001" }).success).toBe(true);
    expect(safeParseUntrusted(BoundedToolArguments, JSON.parse('{"__proto__":{"actorId":"act_synthAttacker000001"}}')).success).toBe(false);
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 12; i++) deep = { next: deep };
    expect(findForbiddenProposalField(deep, 8)).toBe("<too-deep>");
    expect(ModelDecision.safeParse(F.modelDecision(deep)).success).toBe(false);
    expect(messages(ModelDecision.safeParse(F.modelDecision({ note: "x".repeat(9_000) })))).toContain("ARGUMENTS_TOO_LARGE");
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => ModelDecision.safeParse(F.modelDecision(cyclic))).not.toThrow();
    expect(ModelDecision.safeParse(F.modelDecision(cyclic)).success).toBe(false);
    expect(ModelDecision.safeParse(F.modelDecision({ big: 10n } as unknown as Record<string, unknown>)).success).toBe(false);
  });
});
