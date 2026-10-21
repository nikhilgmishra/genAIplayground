import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyAction } from "../protocol/policy.js";
import { ALWAYS_AVAILABLE_ACTIONS, PolicyBundleData, catalogueInvariantViolations, type PolicyCatalogue } from "./catalogue.js";
import { POLICY_ROOT } from "./engine.js";

const raw = JSON.parse(readFileSync(join(POLICY_ROOT, "vsp", "data.json"), "utf8")) as unknown;
const catalogue = (): PolicyCatalogue => structuredClone(PolicyBundleData.parse(raw).vsp.catalogue);
const violations = (c: PolicyCatalogue) => catalogueInvariantViolations(c);

describe("action catalogue (versioned bundle data)", () => {
  it("[OPS-06] the committed catalogue parses strictly and satisfies every structural invariant", () => {
    const c = catalogue();
    expect(violations(c)).toEqual([]);
    for (const name of ALWAYS_AVAILABLE_ACTIONS) expect(c.actions[name]?.killSwitchClass).toBe("EXEMPT");
  });

  it("[SPEC-4.workflow-catalogue] covers every action the module contract requires", () => {
    const required = [
      "safety:route", "human:request", "public:read", "intake:create", "complaint:create", "verification:begin", "login_help:read",
      "appointment:read", "appointment:prepare_change", "appointment:commit_change", "invoice:read", "billing:submit_review", "claim:read",
      "onboarding:read", "remittance:read", "partner_intake:create", "case:read", "support_request:create",
      "account:change_payout_destination", "account:change_tax_info", "credentialing:decide", "clinical_record:read", "identity:recover",
    ];
    const c = catalogue();
    for (const a of required) {
      expect(PolicyAction.safeParse(a).success).toBe(true);
      expect(c.actions[a], a).toBeDefined();
    }
  });

  it("[FO-05-06] every human-boundary action is on the human-only high-risk list; the list names known actions and never the safety or human routes", () => {
    const c = catalogue();
    expect(c.highRisk.humanOnlyActions).toEqual(expect.arrayContaining(Object.entries(c.actions).filter(([, a]) => a.class === "HUMAN_BOUNDARY").map(([n]) => n)));
    const dropped = catalogue();
    dropped.highRisk.humanOnlyActions = dropped.highRisk.humanOnlyActions.filter((a) => a !== "identity:recover");
    expect(violations(dropped)).toContain("HUMAN_BOUNDARY_NOT_HUMAN_ONLY:identity:recover");
    const routes = catalogue();
    routes.highRisk.humanOnlyActions.push("human:request", "nothing:here");
    expect(violations(routes)).toEqual(expect.arrayContaining(["HIGH_RISK_ALWAYS_AVAILABLE:human:request", "HIGH_RISK_ACTION_UNKNOWN:nothing:here"]));
    expect(PolicyBundleData.safeParse({ vsp: { catalogue: routes } }).success).toBe(false);
  });

  it("[FO-05-03] A1 operations need a tenant approval record and must be low-risk; an A1 path minimum only exists on an approved operation", () => {
    const c = catalogue();
    expect(c.assuranceA1).toMatchObject({ approvalRef: null, operations: [] });
    const unapproved = catalogue();
    unapproved.assuranceA1.operations = ["public:read"];
    expect(violations(unapproved)).toContain("A1_OPERATIONS_WITHOUT_APPROVAL");
    const risky = catalogue();
    risky.assuranceA1 = { ...risky.assuranceA1, approvalRef: "apr_synthTenantA1Approval", operations: ["appointment:commit_change", "invoice:read", "identity:recover", "public:read", "nothing:here"] };
    expect(violations(risky)).toEqual(
      expect.arrayContaining(["A1_OPERATION_NOT_LOW_RISK:appointment:commit_change", "A1_OPERATION_NOT_LOW_RISK:invoice:read", "A1_OPERATION_HIGH_RISK:identity:recover", "A1_OPERATION_UNKNOWN:nothing:here"]),
    );
    expect(violations(risky).some((v) => v.endsWith(":public:read"))).toBe(false);
    const path = catalogue();
    const read = path.actions["onboarding:read"]!;
    path.actions["onboarding:read"] = { ...read, access: read.access.map((p) => ({ ...p, minAssurance: "A1" as const })) };
    expect(violations(path).some((v) => v.startsWith("A1_PATH_NOT_APPROVED:onboarding:read:"))).toBe(true);
  });

  it("[SAFE-02] an exemption cannot be granted to any other action through data", () => {
    const c = catalogue();
    c.actions["invoice:read"] = { ...c.actions["invoice:read"]!, class: "SAFETY_AND_HUMAN_ROUTE", killSwitchClass: "EXEMPT" };
    expect(violations(c)).toContain("EXEMPTION_OUTSIDE_SAFETY_HUMAN:invoice:read");
    expect(PolicyBundleData.safeParse({ vsp: { catalogue: c } }).success).toBe(false);
  });

  it("[AUTH-05] a PHI action reachable without a relationship or below A2 is rejected", () => {
    const c = catalogue();
    const appt = c.actions["appointment:read"]!;
    c.actions["appointment:read"] = { ...appt, access: [...appt.access, { ...appt.access[0]!, id: "open", target: "none", factTypes: [], minAssurance: "A0" }] };
    const v = violations(c);
    expect(v).toContain("SENSITIVE_PATH_WEAK:appointment:read:open");
    expect(v).toContain("OPEN_PATH_SENSITIVE:appointment:read:open");
  });

  it("[ACT-01] a mutation that escapes the writes switch, confirmation or digest is rejected", () => {
    const c = catalogue();
    const commit = c.actions["appointment:commit_change"]!;
    c.actions["appointment:commit_change"] = { ...commit, killSwitchClass: "STANDARD", requiresActionDigest: false, obligations: [] };
    expect(violations(c)).toEqual(expect.arrayContaining(["MUTATION_KILL_SWITCH_CLASS:appointment:commit_change", "COMMIT_DIGEST_REQUIREMENT:appointment:commit_change", "MUTATION_WITHOUT_CONFIRMATION:appointment:commit_change"]));
  });

  it("[AUTH-05] partner paths must stay organization-scoped and paths cannot widen action lists", () => {
    const c = catalogue();
    const k = c.actions["case:read"]!;
    c.actions["case:read"] = { ...k, access: k.access.map((p) => (p.id === "partner" ? { ...p, target: "organization_with_subject" as const, roles: [...p.roles, "personal_representative" as const] } : p)) };
    expect(violations(c)).toEqual(expect.arrayContaining(["PARTNER_PATH_NOT_ORGANIZATION:case:read:partner", "PATH_WIDENS_ROLES:case:read:partner"]));
  });

  it("[SPEC-7.staff-separation] auditor on a mutating console action or roles on a prohibited one are rejected", () => {
    const c = catalogue();
    c.console.actions["secret:rotate"] = { ...c.console.actions["secret:rotate"]!, roles: ["auditor", "security_admin"] };
    c.console.actions["db:raw_query"] = { ...c.console.actions["db:raw_query"]!, roles: ["security_admin"] };
    expect(violations(c)).toEqual(expect.arrayContaining(["AUDITOR_MUTATES:secret:rotate", "PROHIBITED_HAS_ROLES:db:raw_query"]));
  });

  it("[AUTH-02] unknown keys in the catalogue are rejected (strict schema)", () => {
    const c = catalogue() as unknown as { actions: Record<string, Record<string, unknown>> };
    c.actions["public:read"]!.allowEveryone = true;
    expect(PolicyBundleData.safeParse({ vsp: { catalogue: c } }).success).toBe(false);
  });

  it("[OPS-06] the pinned WASM capabilities match the installed opa-wasm SDK builtins", () => {
    const require = createRequire(import.meta.url);
    const sdkDir = join(require.resolve("@open-policy-agent/opa-wasm"), "..", "..");
    const sdk = JSON.parse(readFileSync(join(sdkDir, "capabilities.json"), "utf8")) as { builtins: { name: string }[] };
    const pinned = JSON.parse(readFileSync(join(POLICY_ROOT, "wasm-capabilities.json"), "utf8")) as { builtins: { name: string }[]; features: string[] };
    expect(pinned.builtins.map((b) => b.name).sort()).toEqual(sdk.builtins.map((b) => b.name).sort());
    expect(pinned.features).toEqual(["rego_v1"]);
    expect(pinned.builtins.some((b) => b.name === "time.parse_rfc3339_ns")).toBe(false);
  });
});
