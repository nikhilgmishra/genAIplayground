/**
 * Root-cause attribution of the non-PASS runs of a local corpus evaluation (ANALYSIS ONLY).
 *
 * LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Reads the append-only run directories
 * evidence/runs/<runId>/ (results.jsonl + call-evidence.jsonl) and the corpus, and assigns every
 * FAIL / INCONCLUSIVE run to the FIRST matching rule below. The rules are the evidence engineer's
 * reading of the recorded backend evidence (tool results, spoken template ids, transfer states,
 * faults injected, outcome) against the scenario expectation; they never change a verdict, and a run
 * no rule matches is reported UNCLASSIFIED.
 *
 * A run is attributed against the scenario definition it was scored against: results join the corpus on
 * (scenarioId, scenarioVersion). When the current corpus holds another version of the scenario, the
 * definition at the run's version is read from the committed history of its scenario file (read-only
 * `git log` / `git show`); a run whose version is found in neither is put under VERSION_MISMATCH and never
 * evaluated against another version's expectations.
 *
 *   cd platform && npx tsx ../evidence/evaluation/tools/attribute-root-causes.mts \
 *     --runs run_a,run_b,... --json ../evidence/evaluation/<name>.root-causes.json \
 *     --md ../evidence/evaluation/<name>.root-causes.md
 *
 * Outputs are written exclusively (an existing file is never overwritten).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "../../../platform/src/evaluation/corpus.js";

type A = { assertionId: string; verdict: string; hardGate: boolean; detail: string };
type R = { scenarioId: string; scenarioVersion: number; repetition: number; verdict: string; variant: string; corpusSplit: string; assertions: A[] };
type E = any;

const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const runs = (arg("--runs") ?? "").split(",").filter(Boolean);
const toolDir = dirname(fileURLToPath(import.meta.url));
const root = join(toolDir, "..", "..", "runs");
const repoRoot = join(toolDir, "..", "..", "..");
const corpus = loadCorpus();
const entry = new Map(corpus.entries.map((e) => [e.scenario.scenarioId, e]));

/** The scenario definition a run was scored against, and where it was found ("corpus" or "git:<commit>"). */
interface Definition { scen: any; borderline: boolean; kind: string; riskFamily: string | undefined; source: string }
const fileHistory = new Map<string, { revs: string[]; docs: Map<string, unknown> }>();
/** The committed revisions of a corpus file, newest first, parsed lazily (none when git or the history is unavailable). */
function* revisionsOf(file: string): Generator<{ rev: string; doc: unknown }> {
  let h = fileHistory.get(file);
  if (!h) {
    let revs: string[] = [];
    try {
      revs = execFileSync("git", ["-C", repoRoot, "log", "--format=%H", "--", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
    } catch {
      revs = [];
    }
    h = { revs, docs: new Map() };
    fileHistory.set(file, h);
  }
  for (const rev of h.revs) {
    if (!h.docs.has(rev)) {
      let doc: unknown = null;
      try {
        doc = JSON.parse(execFileSync("git", ["-C", repoRoot, "show", `${rev}:${file}`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
      } catch {
        doc = null;
      }
      h.docs.set(rev, doc);
    }
    const doc = h.docs.get(rev);
    if (doc !== null && doc !== undefined) yield { rev, doc };
  }
}
const definitions = new Map<string, Definition | null>();
/** Join on (scenarioId, scenarioVersion): the current corpus entry, else the committed history of its file; null when neither has that version. */
function definitionFor(id: string, version: number): Definition | null {
  const key = `${id}@${version}`;
  if (definitions.has(key)) return definitions.get(key) ?? null;
  const en = entry.get(id);
  let def: Definition | null = null;
  if (en && en.scenario.version === version) def = { scen: en.scenario, borderline: en.borderline === true, kind: en.kind, riskFamily: en.riskFamily, source: "corpus" };
  else if (en) {
    for (const { rev, doc } of revisionsOf(en.file)) {
      const d = doc as any;
      const found = en.kind === "risk_draft" ? (d?.drafts ?? []).find((x: any) => x?.scenario?.scenarioId === id && x?.scenario?.version === version) : d?.scenarioId === id && d?.version === version ? { scenario: d } : undefined;
      if (found) {
        def = { scen: found.scenario, borderline: found.borderline === true, kind: en.kind, riskFamily: en.kind === "risk_draft" ? (d?.family ?? en.riskFamily) : undefined, source: `git:${rev.slice(0, 12)}` };
        break;
      }
    }
  }
  definitions.set(key, def);
  return def;
}
const VERSION_MISMATCH = {
  id: "VERSION_MISMATCH",
  title: "The run was scored against a scenario version that is in neither the current corpus nor the committed history of the scenario's file (or the scenario id is no longer in the corpus): not attributed, because the expectations it was scored against are unknown here; it is never compared with another version's expectations",
  owner: "evidence engineer (attribute against the corpus revision the run used, or re-run on the current corpus)",
};

interface Cause { id: string; title: string; owner: string; test: (r: R, e: E, ctx: Ctx) => boolean }
interface Ctx { scen: any; borderline: boolean; failed: A[]; hardFailed: A[]; tools: any[]; spoken: string[]; purposes: string[]; actual: string | null; expected: string | null; unsupported: string[]; notInjected: string[] }

const has = (xs: string[], re: RegExp) => xs.some((x) => re.test(x));

// Ordered: the first matching cause wins.
const CAUSES: Cause[] = [
  {
    id: "COORDINATOR_COULD_NOT_INTERPRET",
    title: "LOCAL SIMULATED COORDINATOR could not interpret or parse a turn (driver reports it as unsupported; INCONCLUSIVE evidence). Since the 2026-10-18 keyword fixes the held-out scn_caller_id_assertion__indirect_or_ambiguous run stays here on purpose: no rule was written from held-out text (spec section 16); a rule for it is a corpus-owner decision",
    owner: "evaluation driver (simulated coordinator); not a backend defect",
    test: (_r, _e, c) => has(c.unsupported, /^COORDINATOR_/),
  },
  {
    id: "FAULT_NOT_REACHED_BY_SCRIPT",
    title: "Fault plan could not manifest on this script (reported not injected; INCONCLUSIVE evidence): DUPLICATE_WEBHOOK with neither an outbox redelivery nor a delivered duplicate telephony transfer event (since 2026-10-18 the driver also redelivers the call's transfer events, so a routing-only script reaches it), CLAIMS_TIMEOUT before get_claim_status on a script whose verification fails (the tool is never called; the payer_claim_inquiry skeleton v2 uses IDP_UNAVAILABLE instead)",
    owner: "risk-draft / skeleton generator (fault-plan pairing; corpus owners)",
    test: (_r, _e, c) => c.notInjected.length > 0 && c.notInjected.every((f) => f === "DUPLICATE_WEBHOOK" || (f === "CLAIMS_TIMEOUT" && !c.tools.some((t) => t.name === "get_claim_status"))),
  },
  {
    id: "DRIVER_TRANSFER_FAULT_NOT_APPLIED_TO_STUDIO_ROUTE",
    title: "Transfer fault armed after the consent-declined-at-start transfer was requested inside startCall (RECEIVER_UNAVAILABLE on transfer state QUEUED never met that transfer); reported not injected, never simulated. Fixed 2026-10-18 (the decline state is set in startCall, Studio's alternative is requested at the first step); kept as a regression detector",
    owner: "evaluation driver (local-driver.ts transfer fault arming)",
    test: (_r, _e, c) => c.notInjected.includes("RECEIVER_UNAVAILABLE") && c.tools.some((t) => t.reasonCode === "VIA_STUDIO_TELEPHONY_CONTROL"),
  },
  {
    id: "AFTER_COMMIT_FAULT_NOT_REACHED_SLOT_CONFLICT",
    title: "After-commit fault never reached: slot_conflict draft script has one confirmation and the first slot is taken (commit FAILED SLOT_UNAVAILABLE before the fault point)",
    owner: "risk-draft generator (crash_after_commit slot_conflict scripts)",
    test: (_r, e, c) => c.notInjected.some((f) => /CRASH_AFTER_COMMIT|PARTIAL_WRITE|SCHEDULING_TIMEOUT_AFTER_COMMIT/.test(f)) && c.scen.initialState?.fixtureSet === "synthetic_world_slot_conflict",
  },
  {
    id: "SAFETY_OVER_ROUTING_BORDERLINE",
    title: "Borderline draft (remote historical reference, bare negation or idiom) expects no route; the backend screen routes it to the SAFETY_PRIORITY human (conservative, not a hard-gate failure)",
    owner: "clinical safety lead decision (PRQ-008); safety lexicon",
    test: (_r, e, c) => c.borderline && c.purposes.includes("SAFETY_PRIORITY") && e?.safety?.signalDetected === true && c.scen.requiredHandoff === "NONE",
  },
  {
    id: "SAFETY_ASR_UNCERTAIN_OVER_ROUTING",
    title: "Routine idiom ('these bills are killing me') at ASR confidence 0.55 (interrupted_or_noisy variant): the detector's ASR_UNCERTAIN rule (confidence < 0.6 with a partial risk lexeme) routes UNRESOLVED to the SAFETY_PRIORITY human by design; the skeleton expects no route",
    owner: "clinical safety lead / ASR calibration decision (PRQ-008; threshold is a placeholder); skeleton expectation",
    test: (_r, e, c) => !c.borderline && c.purposes.includes("SAFETY_PRIORITY") && e?.safety?.signalDetected === true && c.scen.requiredHandoff === "NONE" && c.scen.variantFamily === "interrupted_or_noisy",
  },
  {
    id: "SCREENING_INITIATED_SAFETY_ROUTE_SEQUENCE",
    title: "Safety route initiated by the Studio utterance-screening endpoint (after a staffed handoff), not by the request_safety_route tool the draft's expected tool sequence names; safety gates PASS. Kept as a regression detector: matches no run once the v2 consent_declined drafts (010, 012, 022, 024) expect request_human_transfer",
    owner: "corpus owners (expected tool sequence for consent_declined drafts)",
    test: (_r, _e, c) => c.failed.some((a) => a.assertionId === "task.tool_sequence" && /request_safety_route/.test(a.detail)) && c.purposes.includes("SAFETY_PRIORITY"),
  },
  {
    id: "KNOWLEDGE_NO_APPROVED_ANSWER",
    title: "search_approved_runbook returned no current approved article (faq_hours, faq_services_overview): the gateway speaks knowledge.no_answer and the call goes to a person, so the outcome is TRANSFERRED with a handoff support record instead of INFORMATION_PROVIDED",
    owner: "knowledge corpus owner (knowledge/corpus/approved has no hours or services-overview article; PRQ-032) — the simulated coordinator's no-approved-answer rule makes it visible",
    test: (_r, _e, c) => has(c.spoken, /^knowledge\.no_answer:/) && c.expected === "INFORMATION_PROVIDED",
  },
  {
    id: "SESSION_INVALID_ROUTED_TO_REVERIFICATION",
    title: "Protected tool denied for an invalid/expired session; the coordinator follows the agent rule 'invalid session -> re-verification by a person' (TRANSFERRED) while the scenario expects DECLINED_BY_POLICY. Kept as a regression detector: matches no run once the v2 expectations (journey 1 AUTH_EXPIRY_MID_CALL, auth_gate_string_values 027-032; talkdesk/studio-flow-spec.md SF-11c) are in place",
    owner: "corpus owners / agent-instruction owner (expectation conflict)",
    test: (_r, _e, c) => c.tools.some((t) => t.status === "POLICY_DENIED" && /^SESSION_|EXPIRED/.test(t.reasonCode ?? "")) && c.actual === "TRANSFERRED" && c.expected === "DECLINED_BY_POLICY",
  },
  {
    id: "POLICY_ENGINE_ERROR_OUTCOME_EXPECTATION",
    title: "POLICY_ENGINE_ERROR dependency variant: requests are denied fail-closed (POLICY_ENGINE_ERROR); the coordinator routes to a person when verification cannot start (TRANSFERRED) or a hostile probe hears the generic denial (CALLER_DISCONNECTED: an engine failure is not recorded as a policy decline); the skeleton expects DECLINED_BY_POLICY",
    owner: "corpus owners / business outcome mapping for engine failures (PRQ-033)",
    test: (_r, e, c) => (e?.faultsInjected ?? []).includes("POLICY_ENGINE_ERROR") && c.expected === "DECLINED_BY_POLICY" && (c.actual === "TRANSFERRED" || c.actual === "CALLER_DISCONNECTED"),
  },
  {
    id: "OUT_OF_ORDER_TRANSFER_EVENT_DROPPED",
    title: "EVENTS_OUT_OF_ORDER: CALLER_CONFIRMED_CONNECTED delivered before BRIDGED is rejected (TRANSFER_EVENT_OUT_OF_ORDER) without a redelivery request or reordering by sequence, so the first leg times out, the fallback leg connects, and TC-11 records OUTCOME_UNKNOWN (NO_SUCCESS_EVIDENCE) instead of TRANSFERRED",
    owner: "workflows/transfer.ts (TransferCoordinator.applyEvent ordering) and the one-outcome-per-session TC-11 gap (gateway telephony-routes / business outcomes)",
    test: (_r, e, c) => (e?.faultsInjected ?? []).includes("EVENTS_OUT_OF_ORDER") && c.actual === "OUTCOME_UNKNOWN" && (e?.transfer?.states ?? []).includes("TIMEOUT"),
  },
  {
    id: "RECONCILED_COMMIT_OUTCOME_REVISION",
    title: "After-commit fault: the reconciler commits the action and appends a RESOLVED outcome revision; the scenario expects the call-end outcome (OUTCOME_UNKNOWN or CALLER_DISCONNECTED)",
    owner: "business owner decision on outcome mapping for reconciled commits (PRQ-033) / corpus owners",
    test: (_r, e, c) => c.actual === "RESOLVED" && (c.expected === "OUTCOME_UNKNOWN" || c.expected === "CALLER_DISCONNECTED") && (e?.committedActions ?? []).length > 0,
  },
  {
    id: "MULTI_REQUEST_CALL_ENDS_WITH_HANDOFF",
    title: "Role switch mid-call: the first role's request is served (verified read succeeded) and the second role's request ends in a human handoff (fresh verification fails -> re-verification by a person; own clinical notes -> person), so the recorded outcome is TRANSFERRED; the skeleton expects INFORMATION_PROVIDED and no support request. HELD-OUT DISCLOSURE: the 2026-10-18 role-switch rule change and the role_switch_mid_call skeleton edit (v2) were made after inspecting the held-out failure of scn_role_switch_mid_call__indirect_or_ambiguous; its post-fix results are not independent acceptance evidence (spec section 16)",
    owner: "corpus owners / outcome precedence for multi-request calls (PRQ-033)",
    test: (_r, _e, c) => c.scen.intent === "role_switch_mid_call" && c.expected === "INFORMATION_PROVIDED" && c.actual === "TRANSFERRED" && c.tools.some((t) => t.status === "SUCCESS" && /^get_/.test(t.name)),
  },
  {
    id: "COORDINATOR_ROLE_NOT_RESOLVED",
    title: "LOCAL SIMULATED COORDINATOR: an indirect opening names no role, so verification starts without a role-specific read (no secure link is delivered for that request) and the call goes to a person before the first role's question is answered. Fixed 2026-10-18 ('one personal' no longer switches roles; a stated personal request does). HELD-OUT DISCLOSURE: that rule change was made after inspecting the held-out failure of scn_role_switch_mid_call__indirect_or_ambiguous; its post-fix results are not independent acceptance evidence (spec section 16)",
    owner: "evaluation driver (simulated coordinator keyword rules); not a backend defect",
    test: (_r, _e, c) => c.scen.intent === "role_switch_mid_call" && c.actual === "TRANSFERRED" && !c.tools.some((t) => t.status === "SUCCESS" && /^get_/.test(t.name)),
  },
  {
    id: "COORDINATOR_INTENT_MISSED",
    title: "LOCAL SIMULATED COORDINATOR did not recognise the request (asked for the caller's role or called no tool) before CALL_END: CALLER_DISCONNECTED. Since 2026-10-18 an explicit hours question outranks a bare billing mention; that rule is justified by development drafts (historical_008, idiom_009, negation_005, negation_008). HELD-OUT DISCLOSURE: the same failure was also observed on held-out scn_risk_safety_idiom_010, whose post-fix results are not independent acceptance evidence (spec section 16)",
    owner: "evaluation driver (simulated coordinator keyword rules); not a backend defect",
    test: (_r, _e, c) => c.actual === "CALLER_DISCONNECTED" && c.tools.length === 0 && (c.scen.expectedToolSequence ?? []).length > 0,
  },
  {
    id: "COORDINATOR_MISREAD_INTENT",
    title: "LOCAL SIMULATED COORDINATOR mapped an indirect request to the wrong tool (an insurance claim question answered with appointment options); the outcome matches but the expected tool sequence does not. Fixed 2026-10-18 (narrow 'waiting to hear back from my insurance' claim rule); kept as a regression detector",
    owner: "evaluation driver (simulated coordinator keyword rules); not a backend defect",
    test: (_r, _e, c) => c.failed.length === 1 && c.failed[0]?.assertionId === "task.tool_sequence" && c.actual === c.expected,
  },
  {
    id: "FAULT_NOT_REACHED_BY_EXPECTED_FLOW",
    title: "Fault paired with a flow that never reaches its injection point (fault-plan.v2 reach check, FO-17-11): SALESFORCE_OUTAGE on a case-read dependency variant (get_authorized_case_status reads the platform's own support-request records and never writes to the CRM), so no support record shows the outage; the run is INCONCLUSIVE, never PASS. Pinned in platform/src/evaluation/corpus.test.ts UNREACHABLE_BY_EXPECTED_FLOW",
    owner: "skeleton generator / corpus owners (fault-plan pairing of the dependency_failure variant)",
    test: (r, e) =>
      r.verdict === "INCONCLUSIVE" &&
      (e?.faultsInjected ?? []).includes("SALESFORCE_OUTAGE") &&
      r.assertions.some((a) => a.assertionId === "evidence.fault_reached.salesforce_outage" && a.verdict === "INCONCLUSIVE"),
  },
  {
    id: "FAULT_REACH_NOT_EVIDENCED_ON_EXEMPT_ROUTE",
    title: "The fault is applied but the flow only uses routes that are exempt from it by design (AUDIT_OUTAGE: route audit is deferred, not refused; QUOTA_EXHAUSTED: safety and human routes are never budget-limited, SAFE-03), so no tool response shows it and the call evidence holds no deferred-audit or budget record: the fault point is not independently observable and the run is INCONCLUSIVE (fault-plan.v2 reach check, FO-17-11); before v2 the driver's self-report counted it as reached",
    owner: "evaluation driver evidence (deferred-audit journal and budget ledger in CallEvidence, WP-34) and the plans' reach rules (WP-01)",
    test: (r) =>
      r.verdict === "INCONCLUSIVE" &&
      r.assertions.some((a) => (a.assertionId === "evidence.fault_reached.audit_outage" || a.assertionId === "evidence.fault_reached.quota_exhausted") && a.verdict === "INCONCLUSIVE"),
  },
  {
    id: "COORDINATOR_REPEATS_FLOW_ON_FOLLOW_UP",
    title: "LOCAL SIMULATED COORDINATOR treats a follow-up turn as a new request (re-prepares the billing review, refused INVOICE_NOT_REVIEWABLE) and routes to a person after the review was accepted. Fixed 2026-10-18 (after a submitted review a follow-up is answered by the backend-authorized get_authorized_case_status; nothing is re-prepared); kept as a regression detector",
    owner: "evaluation driver (simulated coordinator); not a backend defect",
    test: (_r, e, c) => c.tools.some((t) => t.name === "prepare_billing_review" && t.reasonCode === "INVOICE_NOT_REVIEWABLE") && (e?.committedActions ?? []).length > 0 && c.actual === "TRANSFERRED",
  },
];

/**
 * Held-out acceptance scenarios whose result after the 2026-10-18 corpus and harness fixes is NOT independent
 * acceptance evidence (spec section 16: separate development and held-out acceptance scenarios). Printed with
 * every attribution; verdicts are unchanged.
 */
const HELD_OUT_DISCLOSURE: readonly string[] = [
  "scn_role_switch_mid_call__indirect_or_ambiguous: the simulated coordinator's role-switch rule ('one personal' selects no role) and the role_switch_mid_call skeleton edit (v2) were made after inspecting this held-out failure.",
  "scn_risk_safety_idiom_010: the hours-precedence rule was also observed failing here; it is justified by the development drafts historical_008, idiom_009, negation_005 and negation_008.",
  "scn_risk_crash_after_commit_017 (script) and scn_risk_auth_gate_string_values_031 (expectation) changed as part of family-wide generator fixes not aimed at system behaviour (scenarios/README.md).",
  "scn_caller_id_assertion__indirect_or_ambiguous: deliberately left without a coordinator rule (no tuning on held-out text); it stays INCONCLUSIVE until the corpus owners decide.",
];

interface Row { scenarioId: string; scenarioVersion: number; definition: string; repetition: number; verdict: string; group: string; split: string; variant: string; family: string; failedHard: string[]; failedTask: string[]; inconclusive: string[]; cause: string; detail: string[] }
const rows: Row[] = [];
for (const id of runs) {
  const dir = join(root, id);
  const ev = new Map<string, E>();
  for (const l of readFileSync(join(dir, "call-evidence.jsonl"), "utf8").split("\n")) {
    if (!l.trim()) continue;
    const x = JSON.parse(l);
    ev.set(`${x.scenarioId}#${x.repetition}`, x.evidence);
  }
  for (const l of readFileSync(join(dir, "results.jsonl"), "utf8").split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as R;
    if (r.verdict === "PASS") continue;
    const e = ev.get(`${r.scenarioId}#${r.repetition}`) ?? null;
    const def = definitionFor(r.scenarioId, r.scenarioVersion);
    const failed = r.assertions.filter((a) => a.verdict === "FAIL");
    const inc = r.assertions.filter((a) => a.verdict === "INCONCLUSIVE");
    const fi = r.assertions.find((a) => a.assertionId === "evidence.faults_injected");
    const notInjected = fi && fi.verdict !== "PASS" ? (fi.detail.match(/not injected: (.*)$/)?.[1] ?? "").split(/,\s*/).filter(Boolean) : [];
    const ctx: Ctx = {
      scen: def?.scen ?? {},
      borderline: def?.borderline === true,
      failed,
      hardFailed: failed.filter((a) => a.hardGate),
      tools: e?.toolCalls ?? [],
      spoken: e?.committedState?.spokenTemplates ?? [],
      purposes: e?.transfer?.purposes ?? [],
      actual: e?.outcome ?? null,
      expected: def?.scen.expectedFinalState?.outcome ?? null,
      unsupported: e?.unsupported ?? [],
      notInjected,
    };
    const cause = def === null ? VERSION_MISMATCH.id : (CAUSES.find((c) => c.test(r, e, ctx))?.id ?? "UNCLASSIFIED");
    const group = !def ? "unknown" : def.kind === "routine" ? `routine_${def.scen.split}` : def.kind === "risk_draft" ? `risk_${def.scen.split}` : def.kind;
    rows.push({ scenarioId: r.scenarioId, scenarioVersion: r.scenarioVersion, definition: def?.source ?? "not_found", repetition: r.repetition, verdict: r.verdict, group, split: r.corpusSplit, variant: r.variant, family: def?.riskFamily ?? def?.scen.intent ?? "unknown", failedHard: ctx.hardFailed.map((a) => a.assertionId), failedTask: failed.filter((a) => !a.hardGate).map((a) => a.assertionId), inconclusive: inc.map((a) => a.assertionId), cause, detail: [...failed, ...inc].map((a) => `${a.assertionId}: ${a.detail}`.slice(0, 200)) });
  }
}

const byCause = new Map<string, Row[]>();
for (const r of rows) byCause.set(r.cause, [...(byCause.get(r.cause) ?? []), r]);
const ids = (rs: Row[]) => { const m = new Map<string, number>(); for (const r of rs) m.set(r.scenarioId, (m.get(r.scenarioId) ?? 0) + 1); return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])); };
const out = {
  label: "LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Root-cause attribution (analysis only; verdicts are unchanged).",
  sourceRuns: runs,
  heldOutDisclosure: HELD_OUT_DISCLOSURE,
  nonPassRuns: rows.length,
  /** Non-PASS runs by where the definition they were scored against was found (join on scenarioId and scenarioVersion). */
  versionJoin: { currentCorpus: rows.filter((r) => r.definition === "corpus").length, committedHistory: rows.filter((r) => r.definition.startsWith("git:")).length, notFound: rows.filter((r) => r.definition === "not_found").length },
  causes: [...CAUSES.map((c) => c.id), VERSION_MISMATCH.id, "UNCLASSIFIED"].filter((k) => byCause.has(k)).map((k) => {
    const rs = byCause.get(k) ?? [];
    const c = [...CAUSES, VERSION_MISMATCH].find((x) => x.id === k);
    return { id: k, title: c?.title ?? "Not matched by any rule", owner: c?.owner ?? "—", runs: rs.length, fail: rs.filter((r) => r.verdict === "FAIL").length, inconclusive: rs.filter((r) => r.verdict === "INCONCLUSIVE").length, hardGateFailRuns: rs.filter((r) => r.failedHard.length > 0).length, failedHardAssertions: [...new Set(rs.flatMap((r) => r.failedHard))].sort(), failedTaskAssertions: [...new Set(rs.flatMap((r) => r.failedTask))].sort(), scenarios: Object.fromEntries(ids(rs)) };
  }),
  rows,
};
if (arg("--json")) writeFileSync(arg("--json") as string, `${JSON.stringify(out, null, 2)}\n`, { flag: "wx" });

if (arg("--md")) {
  const L: string[] = [];
  const total = rows.length;
  L.push("# Local evaluation — root-cause attribution of non-PASS runs", "");
  L.push("> **LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION.** `executionMode: local_fixture`; LOCAL SIMULATED COORDINATOR (deterministic keyword rules, not a language model). Analysis only: every verdict is unchanged; each FAIL / INCONCLUSIVE run is assigned to the first matching rule in `tools/attribute-root-causes.mts`.", "");
  L.push(`Source runs: ${runs.map((r) => `\`${r}\``).join(", ")}.`, "");
  L.push("Held-out disclosure (results below are not independent acceptance evidence for these scenarios):", "", ...HELD_OUT_DISCLOSURE.map((d) => `- ${d}`), "");
  L.push(`Non-PASS runs: ${total} (FAIL ${rows.filter((r) => r.verdict === "FAIL").length}, INCONCLUSIVE ${rows.filter((r) => r.verdict === "INCONCLUSIVE").length}); unclassified: ${rows.filter((r) => r.cause === "UNCLASSIFIED").length}.`, "");
  L.push(`Each run is attributed against the scenario version it was scored against (join on scenarioId and scenarioVersion): ${out.versionJoin.currentCorpus} from the current corpus, ${out.versionJoin.committedHistory} from the committed history of the scenario file, ${out.versionJoin.notFound} not found (\`${VERSION_MISMATCH.id}\`).`, "");
  L.push("## Summary", "", "| Root cause | Owner | Runs | FAIL | INCONCLUSIVE | Runs failing a hard gate | Failing hard assertions | Failing task assertions | Scenarios |", "|---|---|---|---|---|---|---|---|---|");
  for (const c of out.causes) L.push(`| \`${c.id}\` | ${c.owner} | ${c.runs} | ${c.fail} | ${c.inconclusive} | ${c.hardGateFailRuns} | ${c.failedHardAssertions.map((a) => `\`${a}\``).join(", ") || "—"} | ${c.failedTaskAssertions.map((a) => `\`${a}\``).join(", ") || "—"} | ${Object.keys(c.scenarios).length} |`);
  L.push("", "## FAIL runs with a failing hard gate, by gate and root cause", "");
  const hard = rows.filter((r) => r.failedHard.length > 0);
  if (hard.length === 0) L.push("None.");
  const gates = [...new Set(hard.flatMap((r) => r.failedHard))].sort();
  for (const g of gates) {
    const rs = hard.filter((r) => r.failedHard.includes(g));
    const byC = new Map<string, Row[]>();
    for (const r of rs) byC.set(r.cause, [...(byC.get(r.cause) ?? []), r]);
    for (const [c, xs] of byC) L.push(`- **${g}** / \`${c}\` — ${xs.length} run(s): ${ids(xs).map(([id, n]) => `\`${id}\` (${n})`).join(", ")}`);
  }
  L.push("", "## Root causes and scenario ids", "", "Scenario ids with the number of non-PASS runs in parentheses.", "");
  for (const c of out.causes) {
    L.push(`### \`${c.id}\``, "", c.title, "", `Owner: ${c.owner}. Runs: ${c.runs} (FAIL ${c.fail}, INCONCLUSIVE ${c.inconclusive}).`, "");
    L.push(Object.entries(c.scenarios).map(([id, n]) => `\`${id}\` (${n})`).join(", "), "");
  }
  writeFileSync(arg("--md") as string, `${L.join("\n")}\n`, { flag: "wx" });
}
console.log(`version join: corpus=${out.versionJoin.currentCorpus} history=${out.versionJoin.committedHistory} notFound=${out.versionJoin.notFound}`);
for (const c of out.causes) console.log(`${c.id}: runs=${c.runs} FAIL=${c.fail} INCONCLUSIVE=${c.inconclusive} hardFail=${c.hardGateFailRuns} hard=[${c.failedHardAssertions}] task=[${c.failedTaskAssertions}] scenarios=${Object.keys(c.scenarios).length}`);
for (const r of rows.filter((r) => r.cause === "UNCLASSIFIED")) console.log("UNCLASSIFIED", r.scenarioId, r.repetition, r.verdict, JSON.stringify(r.detail));
