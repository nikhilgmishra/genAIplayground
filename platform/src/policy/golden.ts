/**
 * Golden decision probes and the "no silent access expansion" gate
 * (spec section 14: "Verify that a policy update cannot silently expand access").
 *
 * policy/golden/probes.json holds SYNTHETIC probe inputs with the expected
 * decision for each. Two independent checks use them:
 *
 *  1. compareProbe(): the WASM engine's actual decision vs the golden
 *     expectation. Any difference fails; a difference that WIDENS access
 *     (deny -> allow, a wider field mask, a dropped obligation) is reported as
 *     SILENT_EXPANSION unless the probe is listed in
 *     policy/golden/approved-expansions.json with a POLICY_RELEASE approval
 *     record that exists in approvals/.
 *  2. findExpansions(): previous probe file vs next probe file. Used by
 *     `golden-generate.ts --update` (refuses to write an unapproved
 *     expansion) and `--gate <baseline>` in CI.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { VersionLabel } from "../protocol/common.js";
import { PolicyInput } from "../protocol/policy.js";
import { ReasonCode } from "../protocol/tools.js";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";
import { ConsoleDecisionInput } from "./console.js";
import type { ConsoleDecision } from "./console.js";
import type { PolicyDecision } from "../protocol/policy.js";
import { POLICY_ROOT } from "./engine.js";

export const GOLDEN_DIR = join(POLICY_ROOT, "golden");
export const PROBES_FILE = join(GOLDEN_DIR, "probes.json");
export const APPROVED_EXPANSIONS_FILE = join(GOLDEN_DIR, "approved-expansions.json");

export const ProbeId = z.string().regex(/^(authz|console)\.[a-z0-9_.:-]{3,180}$/);

export const GoldenExpectation = z.strictObject({
  allow: z.boolean(),
  reasonCodes: z.array(ReasonCode).min(1).max(16),
  fieldMask: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{0,80}$/)).max(64),
  obligations: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/)).max(8),
});
export type GoldenExpectation = z.infer<typeof GoldenExpectation>;

const ProbeMeta = {
  id: ProbeId,
  description: z.string().min(5).max(300),
  /** Requirement tags, e.g. "AUTH-05", "SAFE-02", "SPEC-14.policy-expansion". */
  tags: z.array(z.string().regex(/^[A-Z]{2,5}-[0-9A-Za-z.-]{1,40}$/)).min(1).max(8),
  expected: GoldenExpectation,
};

export const GoldenProbe = z.discriminatedUnion("entrypoint", [
  z.strictObject({ ...ProbeMeta, entrypoint: z.literal("authz"), input: PolicyInput }),
  z.strictObject({ ...ProbeMeta, entrypoint: z.literal("console"), input: ConsoleDecisionInput }),
]);
export type GoldenProbe = z.infer<typeof GoldenProbe>;

export const GoldenProbeFile = z
  .strictObject({
    schemaVersion: z.literal(1),
    label: z.string().min(10).max(400),
    generator: z.string().min(3).max(200),
    generatedForPolicyVersion: VersionLabel,
    probeCount: z.number().int().min(0),
    probes: z.array(GoldenProbe),
  })
  .superRefine((f, ctx) => {
    if (f.probeCount !== f.probes.length) ctx.addIssue({ code: "custom", message: "PROBE_COUNT_MISMATCH" });
    const ids = new Set<string>();
    for (const p of f.probes) {
      if (ids.has(p.id)) ctx.addIssue({ code: "custom", message: `DUPLICATE_PROBE_ID:${p.id}` });
      ids.add(p.id);
    }
  });
export type GoldenProbeFile = z.infer<typeof GoldenProbeFile>;

export const ApprovedExpansion = z.strictObject({
  probeId: ProbeId,
  approvedBy: z.string().min(2).max(120),
  /** Must reference a POLICY_RELEASE ApprovalRecord in approvals/ (the coding agent cannot create one). */
  approvalId: z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/),
  reason: z.string().min(10).max(600),
});
export type ApprovedExpansion = z.infer<typeof ApprovedExpansion>;

export const ApprovedExpansions = z.array(ApprovedExpansion).max(1000);

export type ExpansionKind = "ALLOW_FLIP" | "FIELD_MASK_WIDENED" | "OBLIGATION_REMOVED" | "PROBE_REMOVED" | "PROBE_INPUT_CHANGED";

export interface ApprovalReference {
  approvalId: string;
  scope: string;
}

/**
 * Entries that genuinely approve an expansion: well-formed and backed by an
 * existing POLICY_RELEASE approval record. Returns the approved probe ids and
 * the reason codes for entries that do not count.
 */
export function resolveApprovedExpansions(entries: readonly ApprovedExpansion[], records: readonly ApprovalReference[]): { approved: Set<string>; rejected: { probeId: string; reasonCode: string }[] } {
  const approved = new Set<string>();
  const rejected: { probeId: string; reasonCode: string }[] = [];
  for (const e of entries) {
    const rec = records.find((r) => r.approvalId === e.approvalId);
    if (!rec) rejected.push({ probeId: e.probeId, reasonCode: "APPROVAL_RECORD_NOT_FOUND" });
    else if (rec.scope !== "POLICY_RELEASE") rejected.push({ probeId: e.probeId, reasonCode: "APPROVAL_SCOPE_NOT_POLICY_RELEASE" });
    else approved.add(e.probeId);
  }
  return { approved, rejected };
}

/** Ways in which `actual` grants more than `expected`. Tightening is never an expansion. */
export function expansionKinds(expected: GoldenExpectation, actual: GoldenExpectation): ExpansionKind[] {
  const kinds: ExpansionKind[] = [];
  if (!expected.allow && actual.allow) kinds.push("ALLOW_FLIP");
  if (expected.allow && actual.allow && actual.fieldMask.some((f) => !expected.fieldMask.includes(f))) kinds.push("FIELD_MASK_WIDENED");
  if (expected.allow === actual.allow && expected.obligations.some((o) => !actual.obligations.includes(o))) kinds.push("OBLIGATION_REMOVED");
  return kinds;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function expectationDiffs(expected: GoldenExpectation, actual: GoldenExpectation): string[] {
  const diffs: string[] = [];
  if (expected.allow !== actual.allow) diffs.push(`allow ${expected.allow} -> ${actual.allow}`);
  if (!sameList(expected.reasonCodes, actual.reasonCodes)) diffs.push(`reasonCodes [${expected.reasonCodes.join(",")}] -> [${actual.reasonCodes.join(",")}]`);
  if (!sameList(expected.fieldMask, actual.fieldMask)) diffs.push(`fieldMask [${expected.fieldMask.join(",")}] -> [${actual.fieldMask.join(",")}]`);
  if (!sameList(expected.obligations, actual.obligations)) diffs.push(`obligations [${expected.obligations.join(",")}] -> [${actual.obligations.join(",")}]`);
  return diffs;
}

export type ProbeOutcome = "MATCH" | "MISMATCH" | "SILENT_EXPANSION" | "APPROVED_EXPANSION";

export interface ProbeComparison {
  probeId: string;
  outcome: ProbeOutcome;
  expansion: ExpansionKind[];
  diffs: string[];
}

/** Compares an actual decision with a probe's golden expectation. */
export function compareProbe(probe: Pick<GoldenProbe, "id" | "expected">, actual: GoldenExpectation, approved: ReadonlySet<string>): ProbeComparison {
  const diffs = expectationDiffs(probe.expected, actual);
  const expansion = expansionKinds(probe.expected, actual);
  let outcome: ProbeOutcome = "MATCH";
  if (expansion.length > 0) outcome = approved.has(probe.id) ? "APPROVED_EXPANSION" : "SILENT_EXPANSION";
  else if (diffs.length > 0) outcome = "MISMATCH";
  return { probeId: probe.id, outcome, expansion, diffs };
}

export interface ExpansionFinding {
  probeId: string;
  kinds: ExpansionKind[];
  approved: boolean;
}

export const probeInputDigest = (p: Pick<GoldenProbe, "input">): string => sha256Hex(canonicalJson(p.input));

/**
 * Expansions between two probe files (previous approved baseline -> next).
 * Removing a probe or changing the input of a probe that expected deny also
 * needs approval: otherwise a deny probe could be deleted or rewritten to
 * hide an expansion.
 */
export function findExpansions(previous: GoldenProbeFile, next: GoldenProbeFile, approved: ReadonlySet<string>): ExpansionFinding[] {
  const nextById = new Map(next.probes.map((p) => [p.id, p]));
  const findings: ExpansionFinding[] = [];
  for (const prev of previous.probes) {
    const cur = nextById.get(prev.id);
    let kinds: ExpansionKind[];
    if (!cur) kinds = ["PROBE_REMOVED"];
    else {
      kinds = expansionKinds(prev.expected, cur.expected);
      if (!prev.expected.allow && probeInputDigest(prev) !== probeInputDigest(cur)) kinds.push("PROBE_INPUT_CHANGED");
    }
    if (kinds.length > 0) findings.push({ probeId: prev.id, kinds, approved: approved.has(prev.id) });
  }
  return findings;
}

export function loadProbeFile(path: string = PROBES_FILE): GoldenProbeFile {
  return GoldenProbeFile.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function loadApprovedExpansions(path: string = APPROVED_EXPANSIONS_FILE): ApprovedExpansion[] {
  return ApprovedExpansions.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Stable, review-friendly serialization: one probe per line, keys sorted,
 * expected before input so a diff shows the decision first.
 */
export function serializeProbeFile(file: GoldenProbeFile): string {
  const head = {
    schemaVersion: file.schemaVersion,
    label: file.label,
    generator: file.generator,
    generatedForPolicyVersion: file.generatedForPolicyVersion,
    probeCount: file.probes.length,
  };
  const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, "");
  const lines = file.probes.map((p) => {
    const ordered = { id: p.id, entrypoint: p.entrypoint, description: p.description, tags: p.tags, expected: sortExpectation(p.expected), input: JSON.parse(canonicalJson(p.input)) as unknown };
    return `    ${JSON.stringify(ordered)}`;
  });
  return `${headJson},\n  "probes": [\n${lines.join(",\n")}\n  ]\n}\n`;
}

export function sortExpectation(e: GoldenExpectation): GoldenExpectation {
  return { allow: e.allow, reasonCodes: [...e.reasonCodes].sort(), fieldMask: [...e.fieldMask].sort(), obligations: [...e.obligations].sort() };
}

/** The engine surface probes need (OpaWasmPolicyEngine satisfies it). */
export interface ProbeEvaluator {
  decideSync(input: unknown): PolicyDecision;
  decideConsoleSync(input: unknown): ConsoleDecision;
}

/** Evaluates one probe through the engine and returns the comparable part of the decision. */
export function evaluateProbe(engine: ProbeEvaluator, probe: GoldenProbe): GoldenExpectation {
  if (probe.entrypoint === "authz") {
    const d = engine.decideSync(probe.input);
    return sortExpectation({ allow: d.allow, reasonCodes: d.reasonCodes, fieldMask: d.fieldMask, obligations: d.obligations });
  }
  const d = engine.decideConsoleSync(probe.input);
  return sortExpectation({ allow: d.allow, reasonCodes: d.reasonCodes, fieldMask: [], obligations: d.obligations });
}
