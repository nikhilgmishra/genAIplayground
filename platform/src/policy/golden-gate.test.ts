/**
 * End-to-end "no silent access expansion" gate (spec section 14).
 *
 * Builds deliberately WEAKENED copies of the policy bundle in a temp directory
 * with the pinned OPA (via a copy of scripts/policy.sh) and shows that the
 * committed golden probes catch each one. The weakened copies are SYNTHETIC
 * test artifacts; nothing here touches policy/ in the repository.
 */
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpaWasmPolicyEngine, PolicyBundleLoadError, REPO_ROOT } from "./engine.js";
import { ensurePolicyBundle } from "./ensure-bundle.js";
import { PROBES_FILE, compareProbe, evaluateProbe, loadProbeFile, serializeProbeFile, type GoldenProbeFile } from "./golden.js";
import { runGoldenCli, type CliIo } from "./golden-generate.js";

const committed = loadProbeFile(PROBES_FILE);
const tmpRoots: string[] = [];
let previousOpaBin: string | undefined;

beforeAll(() => {
  previousOpaBin = process.env.OPA_BIN;
  process.env.OPA_BIN = join(REPO_ROOT, ".tools", "opa");
});

afterAll(() => {
  if (previousOpaBin === undefined) delete process.env.OPA_BIN;
  else process.env.OPA_BIN = previousOpaBin;
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** Copies policy sources + build script to a temp repo root, applies `mutate`, builds with the pinned OPA. */
function buildVariant(mutate: (policyDir: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "vsp-policy-variant-"));
  tmpRoots.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(REPO_ROOT, "scripts", "policy.sh"), join(root, "scripts", "policy.sh"));
  const policyDir = join(root, "policy");
  mkdirSync(policyDir);
  cpSync(join(REPO_ROOT, "policy", "vsp"), join(policyDir, "vsp"), { recursive: true });
  for (const f of ["VERSION", "wasm-capabilities.json"]) copyFileSync(join(REPO_ROOT, "policy", f), join(policyDir, f));
  mutate(policyDir);
  return ensurePolicyBundle({ repoRoot: root }).bundleDir;
}

function editJson(path: string, edit: (doc: { vsp: { catalogue: { actions: Record<string, Record<string, unknown> & { access: Record<string, unknown>[]; fieldMask: string[] }> } } }) => void): void {
  const doc = JSON.parse(readFileSync(path, "utf8")) as Parameters<typeof edit>[0];
  edit(doc);
  writeFileSync(path, JSON.stringify(doc, null, 2));
}

function editText(path: string, from: string, to: string): void {
  const text = readFileSync(path, "utf8");
  if (!text.includes(from)) throw new Error("variant edit anchor not found");
  writeFileSync(path, text.replace(from, to));
}

async function runProbes(bundleDir: string, approved: ReadonlySet<string> = new Set()) {
  const engine = await OpaWasmPolicyEngine.load({ bundleDir });
  return committed.probes.map((p) => compareProbe(p, evaluateProbe(engine, p), approved));
}

describe("expansion gate against deliberately weakened policies", () => {
  it("[SPEC-14.policy-expansion] [DATA-03] removing the consent-declined rule loses the human-alternative obligation and is caught", async () => {
    const dir = buildVariant((policy) => editText(join(policy, "vsp", "authz.rego"), 'consent_declined if input.auth.consentAutomatedProcessing == "DECLINED"', 'consent_declined if input.auth.consentAutomatedProcessing == "NEVER_MATCHES"'));
    const results = await runProbes(dir);
    const silent = results.filter((r) => r.outcome === "SILENT_EXPANSION");
    // Still denied (UNKNOWN-is-not-consent catches DECLINED), but REQUIRE_HUMAN is gone.
    expect(silent.map((r) => r.probeId)).toContain("authz.client_self_appointment_read.consent_processing_declined");
    expect(silent.every((r) => r.expansion.includes("OBLIGATION_REMOVED"))).toBe(true);
    expect(silent.every((r) => r.probeId.includes("consent_processing_declined") || r.probeId === "authz.explicit.all_reasons_reported")).toBe(true);
    expect(results.find((r) => r.probeId === "authz.client_self_appointment_read.consent_recording_declined")?.outcome).toBe("MATCH");
  });

  it("[SPEC-14.policy-expansion] [DATA-03] disabling both consent rules in Rego is caught as a silent deny -> allow flip; approval makes it explicit", async () => {
    const dir = buildVariant((policy) => {
      const file = join(policy, "vsp", "authz.rego");
      editText(file, 'consent_declined if input.auth.consentAutomatedProcessing == "DECLINED"', 'consent_declined if input.auth.consentAutomatedProcessing == "NEVER_MATCHES"');
      editText(file, 'processing_consent_ok if input.auth.consentAutomatedProcessing in {"GRANTED", "NOT_REQUIRED"}', 'processing_consent_ok if input.auth.consentAutomatedProcessing in {"GRANTED", "NOT_REQUIRED", "DECLINED"}');
    });
    const results = await runProbes(dir);
    const silent = results.filter((r) => r.outcome === "SILENT_EXPANSION");
    const flips = silent.filter((r) => r.expansion.includes("ALLOW_FLIP")).map((r) => r.probeId);
    expect(flips).toContain("authz.client_self_appointment_read.consent_processing_declined");
    expect(flips).toContain("authz.client_commit_change.consent_processing_declined");
    expect(flips.every((id) => id.includes("consent_processing_declined"))).toBe(true);
    expect(results.find((r) => r.probeId === "authz.client_self_appointment_read.consent_recording_declined")?.outcome).toBe("MATCH");

    const approvedRun = await runProbes(dir, new Set(silent.map((r) => r.probeId)));
    expect(approvedRun.filter((r) => r.outcome === "SILENT_EXPANSION")).toEqual([]);
    expect(approvedRun.filter((r) => r.outcome === "APPROVED_EXPANSION")).toHaveLength(silent.length);
  });

  it("[SPEC-14.policy-expansion] [DATA-01] widening a field mask in catalogue data is caught as FIELD_MASK_WIDENED", async () => {
    const dir = buildVariant((policy) =>
      editJson(join(policy, "vsp", "data.json"), (doc) => {
        doc.vsp.catalogue.actions["appointment:read"]!.fieldMask.push("subjectId");
      }),
    );
    const silent = (await runProbes(dir)).filter((r) => r.outcome === "SILENT_EXPANSION");
    expect(silent.map((r) => r.probeId)).toContain("authz.client_self_appointment_read.base");
    expect(silent.map((r) => r.probeId)).toContain("authz.treating_provider_appointment_read.base");
    expect(silent.every((r) => r.expansion.includes("FIELD_MASK_WIDENED"))).toBe(true);
  });

  it("[SPEC-14.policy-expansion] [AUTH-05] a catalogue change that lets a PHI path below A2 is refused at load", async () => {
    const dir = buildVariant((policy) =>
      editJson(join(policy, "vsp", "data.json"), (doc) => {
        const a = doc.vsp.catalogue.actions["appointment:read"]!;
        a.minAssurance = "A1";
        a.access[0]!.minAssurance = "A1";
      }),
    );
    await expect(OpaWasmPolicyEngine.load({ bundleDir: dir })).rejects.toMatchObject({ reasonCode: "POLICY_BUNDLE_CATALOGUE_INVALID" });
    await expect(OpaWasmPolicyEngine.load({ bundleDir: dir })).rejects.toBeInstanceOf(PolicyBundleLoadError);
  });

  it("[SPEC-14.policy-expansion] [AUTH-05] dropping a deny rule changes reason codes and fails as MISMATCH", async () => {
    const dir = buildVariant((policy) => editText(join(policy, "vsp", "authz.rego"), "\trole in partner_roles\n\tsubject_targeted\n", '\trole in partner_roles\n\tsubject_targeted\n\tinput.action == "never:matches"\n'));
    const results = await runProbes(dir);
    const changed = results.filter((r) => r.outcome !== "MATCH");
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((r) => r.outcome === "MISMATCH")).toBe(true);
    expect(changed.map((r) => r.probeId)).toContain("authz.explicit.partner_individual_case");
  });
});

describe("golden-generate CLI", () => {
  const sink = (): CliIo & { lines: string[] } => {
    const lines: string[] = [];
    return { lines, out: (l) => lines.push(`OUT ${l}`), err: (l) => lines.push(`ERR ${l}`) };
  };
  let bundleDir: string;
  let work: string;
  beforeAll(() => {
    bundleDir = ensurePolicyBundle().bundleDir;
    work = mkdtempSync(join(tmpdir(), "vsp-golden-cli-"));
    tmpRoots.push(work);
    mkdirSync(join(work, "approvals"));
  });

  const paths = (name: string, approvedFile = join(work, "approved-none.json")) => ({ probesFile: join(work, name), approvedExpansionsFile: approvedFile, approvalsDir: join(work, "approvals"), bundleDir });
  const allowProbeId = "authz.client_self_appointment_read.base";
  /** A baseline in which an allowed probe was previously denied: regenerating it is a deny -> allow flip. */
  const tightenedBaseline = (): GoldenProbeFile => ({
    ...committed,
    probes: committed.probes.map((p) => (p.id === allowProbeId ? { ...p, expected: { allow: false, reasonCodes: ["ASSURANCE_INSUFFICIENT"], fieldMask: [], obligations: [] } } : p)),
  });

  it("[SPEC-14.policy-expansion] check mode passes on the committed probes", async () => {
    writeFileSync(join(work, "approved-none.json"), "[]\n");
    copyFileSync(PROBES_FILE, join(work, "check.json"));
    const io = sink();
    expect(await runGoldenCli([], io, paths("check.json"))).toBe(0);
  });

  it("[SPEC-14.policy-expansion] check mode fails when probes.json is stale or hand-edited", async () => {
    writeFileSync(join(work, "stale.json"), serializeProbeFile(tightenedBaseline()));
    const io = sink();
    expect(await runGoldenCli([], io, paths("stale.json"))).toBe(1);
    expect(io.lines.some((l) => l.includes("out of date"))).toBe(true);
  });

  it("[SPEC-14.policy-expansion] --update refuses to flip deny -> allow without an approved expansion and writes nothing", async () => {
    const before = serializeProbeFile(tightenedBaseline());
    writeFileSync(join(work, "refuse.json"), before);
    const io = sink();
    expect(await runGoldenCli(["--update"], io, paths("refuse.json"))).toBe(2);
    expect(readFileSync(join(work, "refuse.json"), "utf8")).toBe(before);
    expect(io.lines.some((l) => l.includes(`REFUSED ${allowProbeId} ALLOW_FLIP`))).toBe(true);
  });

  it("[SPEC-14.policy-expansion] --update refuses an approval entry without a POLICY_RELEASE approval record", async () => {
    writeFileSync(join(work, "refuse2.json"), serializeProbeFile(tightenedBaseline()));
    const approvedFile = join(work, "approved-unbacked.json");
    writeFileSync(approvedFile, JSON.stringify([{ probeId: allowProbeId, approvedBy: "Synthetic Approver", approvalId: "apr_synthUnbacked0001", reason: "SYNTHETIC entry with no approval record" }]));
    const io = sink();
    expect(await runGoldenCli(["--update"], io, paths("refuse2.json", approvedFile))).toBe(2);
    expect(io.lines.some((l) => l.includes("APPROVAL_RECORD_NOT_FOUND"))).toBe(true);
  });

  it("[SPEC-14.policy-expansion] --update proceeds when the expansion is backed by a POLICY_RELEASE approval record; --gate agrees", async () => {
    writeFileSync(join(work, "approved.json"), serializeProbeFile(tightenedBaseline()));
    writeFileSync(join(work, "baseline.json"), serializeProbeFile(tightenedBaseline()));
    // SYNTHETIC TEST FIXTURE approval record in a temp directory (never in approvals/).
    writeFileSync(
      join(work, "approvals", "apr_synthTestOnly0001.json"),
      JSON.stringify({
        approvalId: "apr_synthTestOnly0001",
        approver: { name: "Synthetic Test Approver", role: "security_leadership" },
        scope: "POLICY_RELEASE",
        scopeDetail: "SYNTHETIC test fixture approving one golden probe expansion",
        environment: "local",
        grantedAt: "2026-10-17T00:00:00.000Z",
        expiresAt: "2026-10-18T00:00:00.000Z",
        evidenceRef: "test://golden-gate",
        signature: null,
      }),
    );
    const approvedFile = join(work, "approved-backed.json");
    writeFileSync(approvedFile, JSON.stringify([{ probeId: allowProbeId, approvedBy: "Synthetic Test Approver", approvalId: "apr_synthTestOnly0001", reason: "SYNTHETIC approved expansion for the CLI test" }]));

    const gateRefused = sink();
    expect(await runGoldenCli(["--gate", join(work, "baseline.json")], gateRefused, { ...paths("check.json") })).toBe(2);
    const gateApproved = sink();
    expect(await runGoldenCli(["--gate", join(work, "baseline.json")], gateApproved, { ...paths("check.json", approvedFile) })).toBe(0);

    const io = sink();
    expect(await runGoldenCli(["--update"], io, paths("approved.json", approvedFile))).toBe(0);
    expect(readFileSync(join(work, "approved.json"), "utf8")).toBe(readFileSync(PROBES_FILE, "utf8"));
  });
});
