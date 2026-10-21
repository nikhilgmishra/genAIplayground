/**
 * Contract checks, including drift against the platform sources it mirrors.
 * The platform files are read as raw text (Vite `?raw`) so the console never
 * imports zod or backend modules.
 */
import { describe, expect, it } from "vitest";
import contractSource from "../../../platform/src/console-api/contract.ts?raw";
import killSwitchSource from "../../../platform/src/ops/kill-switches.ts?raw";
import staffAuthzSource from "../../../platform/src/ops/staff-authz.ts?raw";
import commonSource from "../../../platform/src/protocol/common.ts?raw";
import contractsSource from "../../../platform/src/protocol/contracts.ts?raw";
import supportSource from "../../../platform/src/protocol/support.ts?raw";
import workflowTypesSource from "../../../platform/src/workflows/types.ts?raw";
import {
  CONSOLE_API_BASE,
  CONSOLE_ENDPOINTS,
  ENDPOINT_ROLES,
  GLOBAL_KILL_SWITCH_SCOPES,
  KILL_SWITCH_SCOPES,
  KILL_SWITCH_SCOPE_ROLES,
  OPERATOR_REASON_CODES,
  OPERATOR_REASON_PATTERN,
  PATH_PARAM_PATTERNS,
  PUBLIC_ENDPOINTS,
  REASON_CODE_PATTERN,
  STAFF_ROLES,
  TRANSFER_REASONS,
} from "./contract";
import type { AuthenticatedEndpointKey, EndpointKey } from "./contract";

const keys = Object.keys(CONSOLE_ENDPOINTS) as EndpointKey[];
const authenticated = keys.filter((k) => !(PUBLIC_ENDPOINTS as readonly string[]).includes(k)) as AuthenticatedEndpointKey[];

function zodEnum(source: string, name: string): string[] {
  const m = new RegExp(`export const ${name} = z\\.enum\\(\\[([\\s\\S]*?)\\]\\)`).exec(source);
  if (!m?.[1]) throw new Error(`enum ${name} not found`);
  return Array.from(m[1].matchAll(/"([^"]+)"/g), (x) => x[1] ?? "");
}

function block(source: string, startMarker: string, endMarker = "};"): string {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`${startMarker} not found`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`${endMarker} not found after ${startMarker}`);
  return source.slice(start, end);
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("console API contract", () => {
  it("[SPEC-13.console] every endpoint lives under /console/api/v1 and every authenticated endpoint declares its roles", () => {
    for (const k of keys) expect(CONSOLE_ENDPOINTS[k].path.startsWith(`${CONSOLE_API_BASE}/`)).toBe(true);
    expect(sorted(Object.keys(ENDPOINT_ROLES))).toEqual(sorted(authenticated));
    for (const k of authenticated) expect(ENDPOINT_ROLES[k].length).toBeGreaterThan(0);
    const paths = keys.map((k) => `${CONSOLE_ENDPOINTS[k].method} ${CONSOLE_ENDPOINTS[k].path}`);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("[SPEC-16.console] no endpoint offers raw queries, secrets, transcripts, recordings or downloads", () => {
    const banned = /^(transcripts?|recordings?|audio|sql|query|raw|secrets?|download|export|exec|shell)$/;
    for (const k of keys) for (const seg of CONSOLE_ENDPOINTS[k].path.split("/")) expect(seg).not.toMatch(banned);
    expect(contractSource).not.toMatch(/\btaskToken\b\s*[?:]/);
    expect(contractSource).not.toMatch(/\btranscript\w*\s*[?:]/i);
  });

  it("[SPEC-16.console] the contract is types and route constants only: no runtime imports", () => {
    expect(contractSource).not.toMatch(/^\s*import\s/m);
    expect(contractSource).not.toMatch(/\brequire\(/);
  });

  it("[SPEC-7.staff] least privilege: the auditor reaches only read endpoints (audit, releases, access reviews, own break-glass requests, me) and can mutate nothing", () => {
    const auditorEndpoints = authenticated.filter((k) => ENDPOINT_ROLES[k].includes("auditor")).sort();
    expect(auditorEndpoints).toEqual(["accessReviews.list", "audit.search", "auth.logout", "breakGlass.list", "me", "releases.list"]);
    for (const k of auditorEndpoints) if (k !== "auth.logout") expect(CONSOLE_ENDPOINTS[k].method).toBe("GET");
    expect(ENDPOINT_ROLES["audit.search"]).toEqual(["auditor", "security_admin"]);
    expect(sorted(ENDPOINT_ROLES["safetyEvents.list"])).toEqual(["safety_responder", "supervisor"]);
    expect(sorted(ENDPOINT_ROLES["releases.review"])).toEqual(["knowledge_editor", "policy_approver"]);
  });

  it("[SPEC-13.console] kill switch scope roles mirror KILL_SWITCH_ROLES in platform/src/ops/staff-authz.ts", () => {
    const src = block(staffAuthzSource, "export const KILL_SWITCH_ROLES");
    const parsed: Record<string, string[]> = {};
    for (const m of src.matchAll(/([A-Z_]+):\s*\[([^\]]*)\]/g)) parsed[m[1] ?? ""] = Array.from((m[2] ?? "").matchAll(/"([^"]+)"/g), (x) => x[1] ?? "");
    expect(sorted(Object.keys(parsed))).toEqual(sorted(KILL_SWITCH_SCOPES));
    for (const scope of KILL_SWITCH_SCOPES) expect(sorted(KILL_SWITCH_SCOPE_ROLES[scope])).toEqual(sorted(parsed[scope] ?? []));
    const killSetUnion = new Set(Object.values(KILL_SWITCH_SCOPE_ROLES).flat());
    expect(sorted([...killSetUnion])).toEqual(sorted(ENDPOINT_ROLES["killSwitches.set"]));
    expect(KILL_SWITCH_SCOPE_ROLES.MODEL_VERSION).toContain("deployment_operator");
    expect(KILL_SWITCH_SCOPE_ROLES.WRITES).not.toContain("deployment_operator");
  });

  it("[SPEC-12.budgets] budget read roles mirror BUDGET_ROLES in platform/src/ops/staff-authz.ts", () => {
    const m = /export const BUDGET_ROLES[^=]*=\s*\[([^\]]*)\]/.exec(staffAuthzSource);
    const roles = Array.from((m?.[1] ?? "").matchAll(/"([^"]+)"/g), (x) => x[1] ?? "");
    expect(sorted(ENDPOINT_ROLES["budgets.list"])).toEqual(sorted(roles));
  });

  it("[SPEC-13.console] global kill switch scopes and the operator reason format mirror platform/src/ops/kill-switches.ts", () => {
    const m = /export const GLOBAL_SCOPES[^=]*=\s*\[([^\]]*)\]/.exec(killSwitchSource);
    expect(sorted(Array.from((m?.[1] ?? "").matchAll(/"([^"]+)"/g), (x) => x[1] ?? ""))).toEqual(sorted(GLOBAL_KILL_SWITCH_SCOPES));
    const r = /export const KILL_SWITCH_REASON = \/(.+)\/;/.exec(killSwitchSource);
    expect(r?.[1]).toBe(OPERATOR_REASON_PATTERN);
  });

  it("[SPEC-7.staff] mirrored enumerations match platform/src/protocol (StaffRole, KillSwitchScope, TransferReason)", () => {
    expect(zodEnum(commonSource, "StaffRole")).toEqual([...STAFF_ROLES]);
    expect(zodEnum(contractsSource, "KillSwitchScope")).toEqual([...KILL_SWITCH_SCOPES]);
    expect(zodEnum(supportSource, "TransferReason")).toEqual([...TRANSFER_REASONS]);
  });

  it("[SPEC-9.workflow-token] workflow task roles equal the staff roles mapped from workflow business roles", () => {
    const src = block(workflowTypesSource, "export const BUSINESS_ROLE_STAFF_MAPPING", "});");
    const mapped = new Set<string>();
    for (const m of src.matchAll(/\[([^\]]*)\]/g)) for (const r of (m[1] ?? "").matchAll(/"([^"]+)"/g)) mapped.add(r[1] ?? "");
    expect(sorted([...mapped])).toEqual(sorted(ENDPOINT_ROLES["workflows.tasks"]));
    expect(sorted(ENDPOINT_ROLES["workflows.decision"])).toEqual(sorted(ENDPOINT_ROLES["workflows.tasks"]));
  });

  it("[SPEC-13.console] every allowlisted operator reason code is a valid reason code without digit runs", () => {
    const re = new RegExp(REASON_CODE_PATTERN);
    for (const codes of Object.values(OPERATOR_REASON_CODES)) {
      expect(codes.length).toBeGreaterThan(0);
      for (const c of codes) {
        expect(c).toMatch(re);
        expect(c).not.toMatch(/\d{4,}/);
      }
    }
  });

  it("[SPEC-6.no-phi-url] path parameter patterns reject phone numbers, names and dates of birth", () => {
    const samples = ["+15555550101", "555-0101", "Avery Synthetic-Client", "1990-01-01", "avery@example.invalid"];
    for (const pattern of Object.values(PATH_PARAM_PATTERNS)) {
      const re = new RegExp(pattern);
      for (const s of samples) expect(re.test(s)).toBe(false);
    }
    expect(new RegExp(PATH_PARAM_PATTERNS.callId).test("cal_synthCallPrimary0001")).toBe(true);
    expect(new RegExp(PATH_PARAM_PATTERNS.ref).test("SR-7KQM-W4XP")).toBe(true);
  });
});
