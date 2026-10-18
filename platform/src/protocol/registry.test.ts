/**
 * Minimum protocol artifacts (spec section 16): every required artifact is registered, is a
 * strict schema (no additional properties) and uses opaque identifiers; ToolResult
 * distinguishes success, retryable failure, permanent failure, policy denial, pending and
 * unknown outcome. Exercises the zod definitions in memory; SYNTHETIC values only.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpaqueId } from "./common.js";
import { PROTOCOL_SCHEMAS } from "./registry.js";

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
