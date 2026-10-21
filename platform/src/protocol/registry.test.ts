/**
 * Minimum protocol artifacts (spec section 16): every required artifact is registered, is a
 * strict schema (no additional properties) and uses opaque identifiers; ToolResult
 * distinguishes success, retryable failure, permanent failure, policy denial, pending and
 * unknown outcome. Exercises the zod definitions in memory; SYNTHETIC values only.
 *
 * The follow-on registry tests (FO-04-48) check the 34 contracts of follow-on prompt section 4
 * against the verbatim prompt text, the generated files and their producing components.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpaqueId, PROTOCOL_VERSION } from "./common.js";
import { PROTOCOL_SCHEMAS } from "./registry.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionConfirmation, ConfirmationReceipt } from "./actions.js";
import { CaseSyncState } from "./effects.js";
import { EvaluationResult, ScenarioDefinition } from "./evaluation.js";
import {
  CONTRACT_ALIASES,
  CONTRACT_VERSION_BY_SCHEMA_KEY,
  FOLLOWON_CONTRACTS,
  FOLLOWON_CONTRACT_NAMES,
  FOLLOWON_SCHEMAS,
  type ContractDescriptor,
} from "./followon.js";
import { driftReport, generatedSchemas, renderAll } from "./generate-schemas.js";
import { loadCorpus } from "../evaluation/corpus.js";
import { ScriptedConversationDriverFixture } from "../evaluation/evidence.fixture.js";
import { runScenarios } from "../evaluation/runner.js";
import { FakeClock } from "../shared/clock.js";
import { commonFieldShapeProblem, contractViolations, envelopeViolations, toJsonSchema } from "./registry-check.js";
import { COMMON_FIELDS, COMMON_FIELD_SPEC_PHRASES, CONTRACT_TRAITS, TRAIT_FIELDS, relevantCommonFields, type CommonField } from "./common-fields.js";
import { SupportReference, SyncState } from "./support.js";

const MINIMUM_ARTIFACTS = [
  "AuthContext",
  "ToolRequest",
  "ToolResult",
  "PreparedAction",
  "CommitReceipt",
  "SupportRequest",
  "HandoffPackage",
  "WorkflowEvent",
  "AuditEvent",
  "ScenarioDefinition",
  "EvaluationResult",
  "ReleaseManifest",
] as const;

interface JsonSchemaNode {
  additionalProperties?: unknown;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  properties?: Record<string, { const?: unknown; pattern?: string }>;
}

const jsonSchemaOf = (name: string): JsonSchemaNode => {
  const schema = PROTOCOL_SCHEMAS[name];
  if (!schema) throw new Error(`missing ${name}`);
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as JsonSchemaNode;
};

describe("minimum protocol artifacts", () => {
  it("[SPEC-16.protocol-artifacts] every required artifact is registered as a strict schema that rejects additional properties", () => {
    for (const name of MINIMUM_ARTIFACTS) {
      const json = jsonSchemaOf(name);
      const branches = json.oneOf ?? json.anyOf ?? [json];
      expect(branches.length, name).toBeGreaterThan(0);
      for (const b of branches) expect(b.additionalProperties, name).toBe(false);
    }
  });

  it("[SPEC-16.protocol-artifacts] ToolResult distinguishes success, retryable, permanent, policy denial, pending and unknown outcome", () => {
    const statuses = (jsonSchemaOf("ToolResult").oneOf ?? []).map((b) => b.properties?.status?.const);
    expect(statuses).toEqual(["SUCCESS", "RETRYABLE_FAILURE", "PERMANENT_FAILURE", "POLICY_DENIED", "PENDING", "UNKNOWN_OUTCOME"]);
  });

  it("[SPEC-16.protocol-artifacts] identifiers are opaque: names, phone numbers, email addresses and short tokens are rejected", () => {
    expect(OpaqueId.safeParse("apt_synthAveryAppt000001").success).toBe(true);
    for (const v of ["Synthetic Person", "555-0101", "avery.synthetic@example.invalid", "apt_short", "APT_synthAveryAppt000001", ""]) {
      expect(OpaqueId.safeParse(v).success, v).toBe(false);
    }
    const auth = jsonSchemaOf("AuthContext").properties ?? {};
    for (const key of ["tenantId", "callId", "sessionRef"]) expect(auth[key]?.pattern, key).toMatch(/_\[A-Za-z0-9_-\]\{16,64\}\$$/);
  });
});

/* ------------------------------------------------------------------------ */
/* Follow-on contract registry (FO-04-48, FO-04-42, FO-04-01, FO-04-02/03)    */
/* ------------------------------------------------------------------------ */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const platformRoot = resolve(here, "../..");

/** The contract list exactly as written in follow-on prompt section 4 ("Required contracts: ..."). */
function requiredContractsFromSpec(): string[] {
  const spec = readFileSync(join(repoRoot, "docs/spec/voice-support-followon-specification.txt"), "utf8");
  const start = spec.indexOf("Required contracts:");
  const end = spec.indexOf(".", start);
  if (start < 0 || end < 0) throw new Error("required contract list not found in the follow-on prompt");
  return spec
    .slice(start + "Required contracts:".length, end)
    .replace(/\band\b/g, ",")
    .split(/[,\s]+/)
    .filter((s) => s.length > 0);
}

describe("follow-on contract registry", () => {
  it("[FO-04-48] FOLLOWON_CONTRACTS lists exactly the 34 contracts of follow-on prompt section 4, in order", () => {
    const fromSpec = requiredContractsFromSpec();
    expect(fromSpec).toHaveLength(34);
    expect([...FOLLOWON_CONTRACT_NAMES]).toEqual(fromSpec);
    expect(Object.keys(FOLLOWON_CONTRACTS)).toEqual(fromSpec);
    for (const name of fromSpec) expect(FOLLOWON_CONTRACTS[name as keyof typeof FOLLOWON_CONTRACTS].name).toBe(name);
  });

  it("[FO-04-48][FO-04-02][FO-04-03][FO-04-42] every follow-on contract is registered, strict on every object node, bounded, versioned and carries its common fields", () => {
    const problems: string[] = [];
    for (const d of Object.values(FOLLOWON_CONTRACTS)) {
      if (FOLLOWON_SCHEMAS[d.schemaKey] !== d.schema) problems.push(`${d.name}: not registered under ${d.schemaKey}`);
      for (const v of contractViolations(d)) problems.push(`${d.name}: ${v}`);
    }
    expect(problems).toEqual([]);
  });

  it("[FO-04-48] the registry check can fail: a non-strict, unversioned, unbounded or envelope-less contract is reported", () => {
    const base: ContractDescriptor = FOLLOWON_CONTRACTS.CallBinding;
    const loose = { ...base, schema: z.object({ schemaVersion: z.literal(base.version), tenantId: z.string() }) };
    expect(contractViolations(loose).join("\n")).toMatch(/additionalProperties:false/);
    const unversioned = { ...base, schema: z.strictObject({ tenantId: OpaqueId }) };
    expect(contractViolations(unversioned).join("\n")).toMatch(/no schemaVersion/);
    const wrongVersion = { ...base, schema: z.strictObject({ schemaVersion: z.literal("call-binding.v9"), tenantId: OpaqueId }) };
    expect(contractViolations(wrongVersion).join("\n")).toMatch(/not pinned/);
    const unbounded = { ...base, commonFields: { schemaVersion: "schemaVersion" }, schema: z.strictObject({ schemaVersion: z.literal(base.version), note: z.string(), refs: z.array(OpaqueId), n: z.number() }) };
    expect(contractViolations(unbounded)).toEqual(expect.arrayContaining(["$.properties.note: unbounded string", "$.properties.refs: array without maxItems", "$.properties.n: unbounded number"]));
    const noEnvelope = { ...base, schema: z.strictObject({ schemaVersion: z.literal(base.version) }) };
    expect(contractViolations(noEnvelope).join("\n")).toMatch(/common field tenantId \(tenantId\) missing/);
    const optionalEnvelope = { ...base, schema: z.strictObject({ schemaVersion: z.literal(base.version), tenantId: OpaqueId.optional() }), commonFields: { schemaVersion: "schemaVersion", tenantId: "tenantId" } };
    expect(contractViolations(optionalEnvelope).join("\n")).toMatch(/not required/);
  });

  it("[FO-04-42] the common-field model covers every field of the prompt's list, including versions, provenance and outcome", () => {
    const spec = readFileSync(join(repoRoot, "docs/spec/voice-support-followon-specification.txt"), "utf8").replace(/\s+/g, " ");
    const start = spec.indexOf("Common fields where relevant:");
    const end = spec.indexOf(". Use UTC instants", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const phrases = spec
      .slice(start + "Common fields where relevant:".length, end)
      .split(/,| and /)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    expect(phrases).toHaveLength(16);
    for (const p of phrases) expect(COMMON_FIELD_SPEC_PHRASES[p], `prompt phrase "${p}" has no common field`).toBeDefined();
    expect(Object.keys(COMMON_FIELD_SPEC_PHRASES).sort()).toEqual([...phrases].sort());
    const covered = new Set(Object.values(COMMON_FIELD_SPEC_PHRASES).flat());
    expect([...COMMON_FIELDS].filter((f) => !covered.has(f))).toEqual([]);
    // Every trait maps to known fields, and every field is relevant to at least one contract.
    for (const fields of Object.values(TRAIT_FIELDS)) for (const f of fields) expect(COMMON_FIELDS).toContain(f);
    const relevantSomewhere = new Set(FOLLOWON_CONTRACT_NAMES.flatMap((n) => relevantCommonFields(n)));
    expect([...COMMON_FIELDS].filter((f) => !relevantSomewhere.has(f))).toEqual([]);
    expect(Object.keys(CONTRACT_TRAITS)).toEqual([...FOLLOWON_CONTRACT_NAMES]);
  });

  it("[FO-04-42] each contract maps exactly the common fields its traits make relevant, with the right shape, and the published files carry the map", () => {
    const counts: Record<string, number> = {};
    for (const d of Object.values(FOLLOWON_CONTRACTS)) {
      expect(Object.keys(d.commonFields).sort(), d.name).toEqual(relevantCommonFields(d.name).sort());
      expect(envelopeViolations(d, toJsonSchema(d.schema)), d.name).toEqual([]);
      for (const f of Object.keys(d.commonFields)) counts[f] = (counts[f] ?? 0) + 1;
      const committed = JSON.parse(readFileSync(join(repoRoot, `schemas/protocol/${d.schemaKey}.schema.json`), "utf8")) as Record<string, unknown>;
      expect(committed["x-common-fields"], d.name).toEqual(d.commonFields);
    }
    // Pinned: how many of the 34 contracts carry each common field. A trait change shows up here and
    // in review; versions, provenance and outcome are checked like the envelope ids.
    expect(counts).toEqual({
      schemaVersion: 34, occurredAt: 32, tenantId: 30, causationId: 30, provenance: 29, versions: 24, interactionId: 14, sessionGeneration: 12,
      expiresAt: 12, outcome: 11, turnId: 10, subjectRef: 9, dataClassification: 9, actorRef: 8, caseId: 8, requestId: 4, workflowId: 4,
    });
  });

  it("[FO-04-42] the common-field check can fail: a dropped relevant field, an irrelevant mapping, a free-text outcome or provenance, an unmapped carried field and an optional nested field are reported", () => {
    const base = FOLLOWON_CONTRACTS.SupportRequest;
    const json = toJsonSchema(base.schema);
    const without = (f: CommonField): ContractDescriptor => ({ ...base, commonFields: Object.fromEntries(Object.entries(base.commonFields).filter(([k]) => k !== f)) });
    for (const f of ["versions", "provenance", "outcome", "tenantId", "occurredAt"] as const) {
      expect(envelopeViolations(without(f), json).join("\n"), f).toMatch(new RegExp(`relevant common field ${f} .* is not mapped`));
    }
    expect(envelopeViolations({ ...base, commonFields: { ...base.commonFields, expiresAt: "deadline" } }, json).join("\n")).toMatch(/expiresAt is mapped but no trait of SupportRequest makes it relevant/);
    expect(envelopeViolations({ ...base, commonFields: { ...base.commonFields, outcome: "summary" } }, json).join("\n")).toMatch(/outcome \(summary\) is not an enumerated outcome/);
    expect(envelopeViolations({ ...base, commonFields: { ...base.commonFields, provenance: "nextStep" } }, json).join("\n")).toMatch(/provenance \(nextStep\) is free text/);
    expect(envelopeViolations({ ...base, commonFields: { ...base.commonFields, occurredAt: "summary" } }, json).join("\n")).toMatch(/occurredAt \(summary\) is not a UTC date-time/);
    const scenario = FOLLOWON_CONTRACTS.ScenarioDefinition;
    const carriesTenant = z.strictObject({ schemaVersion: z.literal(scenario.version), tenantId: OpaqueId, version: z.number().int().min(1).max(9), expectedFinalState: z.strictObject({ outcome: z.enum(["RESOLVED"]) }) });
    expect(envelopeViolations(scenario, toJsonSchema(carriesTenant)).join("\n")).toMatch(/property tenantId carries common field tenantId, which no trait of ScenarioDefinition makes relevant/);
    const optionalNested = z.strictObject({ schemaVersion: z.literal(scenario.version), version: z.number().int().min(1).max(9), expectedFinalState: z.strictObject({ outcome: z.enum(["RESOLVED"]).optional() }) });
    expect(envelopeViolations({ ...scenario, optionalUntilAdoption: [] }, toJsonSchema(optionalNested)).join("\n")).toMatch(/outcome \(expectedFinalState.outcome\) not required/);
  });

  it("[FO-04-48][FO-04-01] every follow-on schema exists in schemas/protocol with the current protocol and contract version, and the generator --check passes", () => {
    const files = renderAll();
    for (const d of Object.values(FOLLOWON_CONTRACTS)) {
      const rel = `schemas/protocol/${d.schemaKey}.schema.json`;
      expect(existsSync(join(repoRoot, rel)), rel).toBe(true);
      const committed = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as Record<string, unknown>;
      expect(committed["x-protocol-version"], rel).toBe(PROTOCOL_VERSION);
      expect(committed["x-contract-version"], rel).toBe(d.version);
      expect(readFileSync(join(repoRoot, rel), "utf8"), rel).toBe(files[rel]);
    }
    expect(driftReport()).toEqual([]);
  });

  it("[FO-04-01] the drift check can fail: a differing, a missing and a stale schema file are each reported (and only *.schema.json files count as stale)", () => {
    const root = mkdtempSync(join(tmpdir(), "vsp-schema-drift-"));
    try {
      for (const [rel, content] of Object.entries(renderAll())) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), content);
      }
      expect(driftReport(root)).toEqual([]);
      rmSync(join(root, "schemas/protocol/CallBinding.schema.json"));
      writeFileSync(join(root, "schemas/protocol/SpeechPlan.schema.json"), "{}\n");
      writeFileSync(join(root, "schemas/protocol/Obsolete.schema.json"), "{}\n");
      writeFileSync(join(root, "schemas/protocol/README.txt"), "not a schema\n");
      writeFileSync(join(root, "approvals/schema/ApprovalRecord.schema.json"), "{}\n");
      expect(driftReport(root).sort()).toEqual([
        "drift: approvals/schema/ApprovalRecord.schema.json",
        "drift: schemas/protocol/SpeechPlan.schema.json",
        "missing: schemas/protocol/CallBinding.schema.json",
        "stale: schemas/protocol/Obsolete.schema.json",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("[FO-04-42][FO-04-03] the common-field shape check can fail for identifiers: a numeric, unbounded or free-text id is reported, an opaque id is accepted", () => {
    expect(commonFieldShapeProblem("tenantId", toJsonSchema(OpaqueId))).toBeNull();
    expect(commonFieldShapeProblem("causationId", toJsonSchema(OpaqueId.nullable()))).toBeNull();
    for (const field of ["tenantId", "interactionId", "caseId", "workflowId", "actorRef", "subjectRef", "turnId", "requestId", "causationId"] as const) {
      expect(commonFieldShapeProblem(field, toJsonSchema(z.number().int().min(1).max(9))), field).toBe("is not a bounded identifier string");
      expect(commonFieldShapeProblem(field, toJsonSchema(z.string())), field).toBe("is not a bounded identifier string");
      expect(commonFieldShapeProblem(field, toJsonSchema(z.union([OpaqueId, z.string()]))), field).toBe("is not a bounded identifier string");
    }
    const base = FOLLOWON_CONTRACTS.CallBinding;
    const numericTenant = z.strictObject({ schemaVersion: z.literal(base.version), tenantId: z.number().int().min(1).max(9) });
    expect(envelopeViolations(base, toJsonSchema(numericTenant)).join("\n")).toMatch(/common field tenantId \(tenantId\) is not a bounded identifier string/);
  });

  it("[FO-04-01] one zod source: the original and follow-on registries never map one name to two different schemas", () => {
    const all = generatedSchemas();
    for (const [name, schema] of Object.entries(PROTOCOL_SCHEMAS)) expect(all[name], name).toBe(schema);
    for (const [name, schema] of Object.entries(FOLLOWON_SCHEMAS)) expect(all[name], name).toBe(schema);
    for (const key of Object.keys(CONTRACT_VERSION_BY_SCHEMA_KEY)) expect(all[key], key).toBeDefined();
  });

  it("[FO-04-01] a producing component marked IN_USE validates that exact contract at its boundary; LEGACY_WIRE producers validate the wire schema they are migrated from", () => {
    for (const d of Object.values(FOLLOWON_CONTRACTS)) {
      if (d.producer.status === "PLANNED") {
        expect(d.adoptionOwner, d.name).toMatch(/^WP-\d{2}$/);
        continue;
      }
      const path = d.producer.path;
      expect(path, d.name).not.toBeNull();
      const source = readFileSync(join(platformRoot, path as string), "utf8");
      const key = d.producer.status === "IN_USE" ? d.schemaKey : (d.producer.wireSchemaKey as string);
      expect(new RegExp(`(\\b${key}\\.(safeParse|parse)\\(|parseOrThrow\\(${key}\\b)`).test(source), `${d.name}: ${path} validates ${key}`).toBe(true);
      if (d.producer.status === "LEGACY_WIRE_IN_USE") expect(d.adoptionOwner, d.name).toMatch(/^WP-\d{2}$/);
    }
  });

  it("[FO-04-36][FO-04-37][FO-04-01] what the IN_USE scorer produces over the committed corpus, and the committed scenarios, parse under the current contracts (runtime evidence beside the source check)", async () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    // The scorer (scoreScenario, reached through runScenarios) is the IN_USE EvaluationResult producer.
    // Its output is generated here over every committed corpus scenario rather than read from
    // evidence/runs/**/results.jsonl: those per-run files are local output (gitignored), so a check
    // over them proves nothing on a fresh checkout. ScriptedConversationDriverFixture is the labelled
    // local fixture driver; the results round-trip through JSON as RunResultWriter stores them.
    const corpus = loadCorpus(repoRoot);
    const { results } = await runScenarios(new ScriptedConversationDriverFixture(), corpus.entries.map((e) => e.scenario), {
      executionMode: "local_fixture",
      environment: "local",
      faultPlans: corpus.faultPlans,
      clock: new FakeClock(),
      runId: "run_registryContract0001",
    });
    const badResults: string[] = [];
    for (const result of results) {
      const r = EvaluationResult.safeParse(JSON.parse(JSON.stringify(result)));
      if (!r.success && badResults.length < 5) badResults.push(`${result.scenarioId}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    expect(badResults).toEqual([]);
    expect(new Set(results.map((r) => r.scenarioId)).size).toBe(corpus.entries.length);
    expect(corpus.entries.length).toBeGreaterThan(100);
    let scenarios = 0;
    const badScenarios: string[] = [];
    for (const file of walk(join(repoRoot, "scenarios")).filter((f) => f.endsWith(".json"))) {
      const json = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (typeof json !== "object" || json === null || !("scenarioId" in json)) continue;
      scenarios++;
      const r = ScenarioDefinition.safeParse(json);
      if (!r.success && badScenarios.length < 5) badScenarios.push(`${file}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    expect(badScenarios).toEqual([]);
    expect(scenarios).toBeGreaterThan(100);
  });

  it("[FO-04-21] ConfirmationReceipt is the ActionConfirmation alias plus receipt id, tenant, actor and expiry", () => {
    expect(CONTRACT_ALIASES.ConfirmationReceipt?.supersedes).toBe("ActionConfirmation");
    const receiptKeys = Object.keys(ConfirmationReceipt.shape);
    for (const k of Object.keys(ActionConfirmation.shape)) expect(receiptKeys, k).toContain(k);
    for (const k of ["receiptId", "tenantId", "actorRef", "expiresAt", "schemaVersion"]) expect(receiptKeys).toContain(k);
    expect(CONTRACT_ALIASES.TenantConfig?.supersedes).toBe("PlatformConfig");
  });

  it("[FO-04-26] locally duplicated enumerations stay identical to their source (CaseSyncState = SyncState; grant source reference = SupportReference)", () => {
    expect(CaseSyncState.options).toEqual(SyncState.options);
    const grantSource = (toJsonSchema(FOLLOWON_CONTRACTS.ActionGrant.schema).properties as Record<string, { anyOf?: { pattern?: string }[] }>).sourceRef?.anyOf ?? [];
    expect(grantSource.map((b) => b.pattern)).toContain((toJsonSchema(SupportReference) as { pattern?: string }).pattern);
  });
});
