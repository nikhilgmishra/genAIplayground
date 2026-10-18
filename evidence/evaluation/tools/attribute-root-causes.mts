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
 *   cd platform && npx tsx ../evidence/evaluation/tools/attribute-root-causes.mts \
 *     --runs run_a,run_b,... --json ../evidence/evaluation/<name>.root-causes.json \
 *     --md ../evidence/evaluation/<name>.root-causes.md
 *
 * Outputs are written exclusively (an existing file is never overwritten).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "../../../platform/src/evaluation/corpus.js";

type A = { assertionId: string; verdict: string; hardGate: boolean; detail: string };
type R = { scenarioId: string; repetition: number; verdict: string; variant: string; corpusSplit: string; assertions: A[] };
type E = any;

const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const runs = (arg("--runs") ?? "").split(",").filter(Boolean);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "runs");
const corpus = loadCorpus();
const entry = new Map(corpus.entries.map((e) => [e.scenario.scenarioId, e]));

interface Cause { id: string; title: string; owner: string; test: (r: R, e: E, ctx: Ctx) => boolean }
interface Ctx { scen: any; borderline: boolean; failed: A[]; hardFailed: A[]; tools: any[]; spoken: string[]; purposes: string[]; actual: string | null; expected: string | null; unsupported: string[]; notInjected: string[] }

const has = (xs: string[], re: RegExp) => xs.some((x) => re.test(x));

// Ordered: the first matching cause wins.
const CAUSES: Cause[] = [
  {
    id: "COORDINATOR_COULD_NOT_INTERPRET",
    title: "LOCAL SIMULATED COORDINATOR could not interpret or parse a turn (driver reports it as unsupported; INCONCLUSIVE evidence)",
    owner: "evaluation driver (simulated coordinator); not a backend defect",
    test: (_r, _e, c) => has(c.unsupported, /^COORDINATOR_/),
  },
  {
    id: "FAULT_NOT_REACHED_BY_SCRIPT",
    title: "Fault plan could not manifest on this script (reported not injected; INCONCLUSIVE evidence): DUPLICATE_WEBHOOK on a routing-only script (no consequential tool runs), CLAIMS_TIMEOUT before get_claim_status on a script whose verification fails (the tool is never called)",
    owner: "risk-draft / skeleton generator (fault-plan pairing; corpus owners)",
    test: (_r, _e, c) => c.notInjected.length > 0 && c.notInjected.every((f) => f === "DUPLICATE_WEBHOOK" || (f === "CLAIMS_TIMEOUT" && !c.tools.some((t) => t.name === "get_claim_status"))),
  },
  {
    id: "DRIVER_TRANSFER_FAULT_NOT_APPLIED_TO_STUDIO_ROUTE",
    title: "RECEIVER_UNAVAILABLE (armed on transfer state QUEUED) is not applied by the local driver to a transfer Studio requests through telephony-control (recording declined); reported not injected, never simulated",
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
    title: "Safety route initiated by the Studio utterance-screening endpoint (after a staffed handoff), not by the request_safety_route tool the draft's expected tool sequence names; safety gates PASS",
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
    title: "Protected tool denied for an invalid/expired session; the coordinator follows the agent rule 'invalid session -> re-verification by a person' (TRANSFERRED) while the scenario expects DECLINED_BY_POLICY",
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
    title: "Role switch mid-call: the first role's request is served (verified read succeeded) and the second role's request ends in a human handoff (fresh verification fails -> re-verification by a person; own clinical notes -> person), so the recorded outcome is TRANSFERRED; the skeleton expects INFORMATION_PROVIDED and no support request",
    owner: "corpus owners / outcome precedence for multi-request calls (PRQ-033)",
    test: (_r, _e, c) => c.scen.intent === "role_switch_mid_call" && c.expected === "INFORMATION_PROVIDED" && c.actual === "TRANSFERRED" && c.tools.some((t) => t.status === "SUCCESS" && /^get_/.test(t.name)),
  },
  {
    id: "COORDINATOR_ROLE_NOT_RESOLVED",
    title: "LOCAL SIMULATED COORDINATOR: an indirect opening names no role, so verification starts without a role-specific read (no secure link is delivered for that request) and the call goes to a person before the first role's question is answered",
    owner: "evaluation driver (simulated coordinator keyword rules); not a backend defect",
    test: (_r, _e, c) => c.scen.intent === "role_switch_mid_call" && c.actual === "TRANSFERRED" && !c.tools.some((t) => t.status === "SUCCESS" && /^get_/.test(t.name)),
  },
  {
    id: "COORDINATOR_INTENT_MISSED",
    title: "LOCAL SIMULATED COORDINATOR did not recognise the request (asked for the caller's role or called no tool) before CALL_END: CALLER_DISCONNECTED",
    owner: "evaluation driver (simulated coordinator keyword rules); not a backend defect",
    test: (_r, _e, c) => c.actual === "CALLER_DISCONNECTED" && c.tools.length === 0 && (c.scen.expectedToolSequence ?? []).length > 0,
  },
  {
    id: "COORDINATOR_MISREAD_INTENT",
    title: "LOCAL SIMULATED COORDINATOR mapped an indirect request to the wrong tool (an insurance claim question answered with appointment options); the outcome matches but the expected tool sequence does not",
    owner: "evaluation driver (simulated coordinator keyword rules); not a backend defect",
    test: (_r, _e, c) => c.failed.length === 1 && c.failed[0]?.assertionId === "task.tool_sequence" && c.actual === c.expected,
  },
  {
    id: "COORDINATOR_REPEATS_FLOW_ON_FOLLOW_UP",
    title: "LOCAL SIMULATED COORDINATOR treats a follow-up turn as a new request (re-prepares the billing review, refused INVOICE_NOT_REVIEWABLE) and routes to a person after the review was accepted",
    owner: "evaluation driver (simulated coordinator); not a backend defect",
    test: (_r, e, c) => c.tools.some((t) => t.name === "prepare_billing_review" && t.reasonCode === "INVOICE_NOT_REVIEWABLE") && (e?.committedActions ?? []).length > 0 && c.actual === "TRANSFERRED",
  },
];

interface Row { scenarioId: string; repetition: number; verdict: string; group: string; split: string; variant: string; family: string; failedHard: string[]; failedTask: string[]; inconclusive: string[]; cause: string; detail: string[] }
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
    const en = entry.get(r.scenarioId);
    const failed = r.assertions.filter((a) => a.verdict === "FAIL");
    const inc = r.assertions.filter((a) => a.verdict === "INCONCLUSIVE");
    const fi = r.assertions.find((a) => a.assertionId === "evidence.faults_injected");
    const notInjected = fi && fi.verdict !== "PASS" ? (fi.detail.match(/not injected: (.*)$/)?.[1] ?? "").split(/,\s*/).filter(Boolean) : [];
    const ctx: Ctx = {
      scen: en?.scenario ?? {},
      borderline: en?.borderline === true,
      failed,
      hardFailed: failed.filter((a) => a.hardGate),
      tools: e?.toolCalls ?? [],
      spoken: e?.committedState?.spokenTemplates ?? [],
      purposes: e?.transfer?.purposes ?? [],
      actual: e?.outcome ?? null,
      expected: en?.scenario.expectedFinalState?.outcome ?? null,
      unsupported: e?.unsupported ?? [],
      notInjected,
    };
    const cause = CAUSES.find((c) => c.test(r, e, ctx))?.id ?? "UNCLASSIFIED";
    const group = !en ? "unknown" : en.kind === "routine" ? `routine_${en.scenario.split}` : en.kind === "risk_draft" ? `risk_${en.scenario.split}` : en.kind;
    rows.push({ scenarioId: r.scenarioId, repetition: r.repetition, verdict: r.verdict, group, split: r.corpusSplit, variant: r.variant, family: en?.riskFamily ?? en?.scenario.intent ?? "unknown", failedHard: ctx.hardFailed.map((a) => a.assertionId), failedTask: failed.filter((a) => !a.hardGate).map((a) => a.assertionId), inconclusive: inc.map((a) => a.assertionId), cause, detail: [...failed, ...inc].map((a) => `${a.assertionId}: ${a.detail}`.slice(0, 200)) });
  }
}

const byCause = new Map<string, Row[]>();
for (const r of rows) byCause.set(r.cause, [...(byCause.get(r.cause) ?? []), r]);
const ids = (rs: Row[]) => { const m = new Map<string, number>(); for (const r of rs) m.set(r.scenarioId, (m.get(r.scenarioId) ?? 0) + 1); return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])); };
const out = {
  label: "LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION. Root-cause attribution (analysis only; verdicts are unchanged).",
  sourceRuns: runs,
  nonPassRuns: rows.length,
  causes: [...CAUSES.map((c) => c.id), "UNCLASSIFIED"].filter((k) => byCause.has(k)).map((k) => {
    const rs = byCause.get(k) ?? [];
    const c = CAUSES.find((x) => x.id === k);
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
  L.push(`Non-PASS runs: ${total} (FAIL ${rows.filter((r) => r.verdict === "FAIL").length}, INCONCLUSIVE ${rows.filter((r) => r.verdict === "INCONCLUSIVE").length}); unclassified: ${rows.filter((r) => r.cause === "UNCLASSIFIED").length}.`, "");
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
for (const c of out.causes) console.log(`${c.id}: runs=${c.runs} FAIL=${c.fail} INCONCLUSIVE=${c.inconclusive} hardFail=${c.hardGateFailRuns} hard=[${c.failedHardAssertions}] task=[${c.failedTaskAssertions}] scenarios=${Object.keys(c.scenarios).length}`);
for (const r of rows.filter((r) => r.cause === "UNCLASSIFIED")) console.log("UNCLASSIFIED", r.scenarioId, r.repetition, r.verdict, JSON.stringify(r.detail));
