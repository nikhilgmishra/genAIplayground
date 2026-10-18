/**
 * `pnpm demo` — the nine required demonstration journeys (spec section 16) end to
 * end on a FRESH LOCAL STACK each (LOCAL FIXTURE composition, SYNTHETIC data).
 *
 * For every step it prints the caller-visible line(s) — text rendered by the
 * gateway's response gate from an approved-template directive, marked with the
 * template id and its approval status — and the backend evidence after the step:
 * action ledger states and receipts, workflow states, support references with
 * their synchronization state, transfer journey states and the durable audit event
 * count. Each journey ends with the IntegrityVerifier result, the recorded outcome
 * and the scorer's verdict.
 *
 * A machine-readable transcript (content-free except SYNTHETIC template text; no
 * caller utterances) is written to evidence/demo/<runId>.json. The process exits
 * non-zero when any journey's backend evidence is missing.
 *
 *   pnpm demo                    # nine journeys
 *   pnpm demo -- --faulted       # plus the twelve fault-injected journeys
 *   pnpm demo -- --transport mcp # tools over the real MCP SDK client (127.0.0.1)
 *
 * The caller side is the LOCAL SIMULATED COORDINATOR (rule-based; NOT a model and
 * NOT model evaluation). Nothing here is vendor, telephone, sandbox or production
 * evidence.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScenarioDefinition } from "../protocol/index.js";
import { systemClock } from "../shared/clock.js";
import { newId } from "../shared/ids.js";
import { loadCorpus } from "../evaluation/corpus.js";
import { CallEvidence } from "../evaluation/runner.js";
import { scoreScenario } from "../evaluation/scorer.js";
import { isImmediateTrigger } from "../evaluation/fault-plan.js";
import { repoPaths } from "../evaluation/paths.js";
import { DRIVER_LABEL, LOCAL_FIXTURE_BADGE, SIMULATED_COORDINATOR_LABEL } from "../evaluation/driver/labels.js";
import { LocalConversationDriver } from "../evaluation/driver/local-driver.js";
import type { StepSnapshot } from "../evaluation/driver/local-driver.js";
import type { ToolTransport } from "../evaluation/driver/local-stack.js";

type Out = (line: string) => void;

export interface DemoStep {
  turnIndex: number;
  speaker: "caller" | "system_event";
  /** System event name only; caller utterances are never written to the transcript. */
  event: string | null;
  spoken: { source: string; templateId: string; approvalStatus: string; gate: string; text: string | null }[];
  tools: { name: string; status: string; reasonCode: string | null; probe: string | null; via: string }[];
  backend: StepSnapshot;
}

export interface DemoJourney {
  scenarioId: string;
  intent: string;
  callId: string;
  faults: string[];
  steps: DemoStep[];
  final: {
    outcome: string | null;
    outcomeReasonCode: string | null;
    committedActions: { actionKind: string; receiptId: string | null; reconciled: boolean; effectCount: number }[];
    supportRequests: { kind: string; referenceIssued: boolean }[];
    transfer: { attempted: boolean; destinationIds: string[]; states: string[]; connectionVerified: boolean; fallbackInvoked: boolean } | null;
    auditIntegrity: unknown;
    auditEventCount: number | null;
    pinned: unknown;
  };
  verdict: string;
  failingAssertions: string[];
  backendEvidenceComplete: boolean;
  missingEvidence: string[];
}

export interface DemoTranscript {
  label: string;
  driver: string;
  coordinator: string;
  runId: string;
  generatedAt: string;
  transport: ToolTransport;
  journeys: DemoJourney[];
  allBackendEvidencePresent: boolean;
}

const BADGE_WIDTH = 78;
const badgeRow = (text: string): string => `#  ${text}`.padEnd(BADGE_WIDTH - 1, " ") + "#";
const BADGE_LINES = [
  "#".repeat(BADGE_WIDTH),
  badgeRow(LOCAL_FIXTURE_BADGE),
  badgeRow("Local adapters only: PGlite, OPA WASM and LOCAL FIXTURE"),
  badgeRow("Talkdesk, Salesforce, IdP and business systems."),
  "#".repeat(BADGE_WIDTH),
];

/** What a journey must leave behind in the backend, derived from its expectations (not from its verdict). */
export function missingBackendEvidence(s: ScenarioDefinition, e: CallEvidence): string[] {
  const missing: string[] = [];
  if (e.outcome === null) missing.push("interaction outcome not recorded");
  if ((e.auditEventIds?.length ?? 0) === 0 && ((e.committedState as { auditEventCount?: number } | null)?.auditEventCount ?? 0) === 0) missing.push("no durable audit events");
  if (s.expectedFinalState.committedActions.length > 0 && !(e.committedActions ?? []).some((a) => a.receiptId !== null)) missing.push("no committed action receipt in the ledger");
  if (s.expectedFinalState.supportRequestCreated === true && (e.supportRequests ?? []).length === 0) missing.push("no support request record");
  if (s.requiredHandoff !== "NONE" && !(e.transfer?.attempted ?? false)) missing.push("no transfer journey");
  if ((e.toolCalls ?? []).length === 0) missing.push("no tool call reached the gateway");
  return missing;
}

function printSnapshot(out: Out, b: StepSnapshot): void {
  const ledger = b.ledger.map((l) => `${l.kind}=${l.state}${l.receiptId ? ` receipt ${l.receiptId}${l.reconciled ? " (reconciled)" : ""}` : ""}`).join("; ") || "—";
  const srs = b.supportRequests.map((r) => `${r.referenceNumber} ${r.disposition} sync=${r.syncState}${r.salesforceCaseId ? " case=" + r.salesforceCaseId : ""}`).join("; ") || "—";
  const wfs = b.workflows.map((w) => `${w.type}=${w.state}`).join("; ") || "—";
  const xfr = b.transfers.map((t) => `${t.priority} ${t.status} [${t.attempts.join(" -> ")}]`).join("; ") || "—";
  out(`      backend: assurance=${b.assurance} | ledger: ${ledger}`);
  out(`               support: ${srs} | workflows: ${wfs}`);
  out(`               transfer: ${xfr} | audit events: ${b.auditEvents}`);
}

export async function runDemo(opts: { faulted?: boolean; transport?: ToolTransport; out?: Out; evidenceRoot?: string; write?: boolean } = {}): Promise<DemoTranscript> {
  const out: Out = opts.out ?? ((l) => console.log(l));
  const corpus = loadCorpus();
  const kinds = new Set(opts.faulted ? ["journey", "journey_faulted"] : ["journey"]);
  const scenarios = corpus.entries.filter((e) => kinds.has(e.kind)).map((e) => e.scenario);
  const transport = opts.transport ?? "http";
  const runId = newId("run").replace(/^run_/, "run_demo_");
  for (const l of BADGE_LINES) out(l);
  out(DRIVER_LABEL);
  out(SIMULATED_COORDINATOR_LABEL);
  out(`run ${runId}; tools over ${transport === "mcp" ? "the MCP SDK client (127.0.0.1)" : "the HTTP tool route (fastify.inject)"}; ${scenarios.length} journeys`);
  const journeys: DemoJourney[] = [];
  for (const scenario of scenarios) {
    let evidence: CallEvidence | null = null;
    let details: unknown = null;
    const driver = new LocalConversationDriver({
      transport,
      onCallComplete: (r) => {
        details = r.details;
      },
    });
    out("");
    out("=".repeat(78));
    out(`${scenario.scenarioId}  (${scenario.intent}; synthetic persona: ${scenario.persona ?? "—"})`.slice(0, 300));
    if (scenario.initialState.faults.length > 0) out(`  injected fault(s): ${scenario.initialState.faults.join(", ")}`);
    const steps: DemoStep[] = [];
    const injectionFailures: string[] = [];
    const h = await driver.startCall({ runId, scenario, repetition: 1, environment: "local" });
    try {
      const atTurn = new Map<number, string[]>();
      for (const faultId of scenario.initialState.faults) {
        const plan = corpus.faultPlans.get(faultId);
        if (!plan) {
          injectionFailures.push(`${faultId}:FAULT_PLAN_MISSING`);
          continue;
        }
        if (plan.trigger.kind === "AT_TURN") {
          atTurn.set(plan.trigger.turnIndex ?? 0, [...(atTurn.get(plan.trigger.turnIndex ?? 0) ?? []), faultId]);
          continue;
        }
        const ack = await driver.injectFault(h, plan, isImmediateTrigger(plan.trigger.kind) ? "now" : "arm");
        if (!ack.accepted) injectionFailures.push(`${faultId}:${ack.reasonCode ?? "NOT_ACCEPTED"}`);
      }
      let seenSpoken = driver.transcriptOf(h).spoken.length;
      let seenTools = driver.transcriptOf(h).tools.length;
      const startLines = driver.transcriptOf(h).spoken;
      for (const l of startLines) out(`  [start] caller hears (${l.templateId}, ${l.approvalStatus}${l.gate === "RENDERED" ? "" : ", gate fallback"}): "${l.text ?? ""}"`);
      for (const [index, turn] of scenario.script.entries()) {
        for (const faultId of atTurn.get(index) ?? []) {
          const plan = corpus.faultPlans.get(faultId);
          if (plan) {
            const ack = await driver.injectFault(h, plan, "now");
            if (!ack.accepted) injectionFailures.push(`${faultId}:${ack.reasonCode ?? "NOT_ACCEPTED"}`);
          }
        }
        out(turn.speaker === "caller" ? `  [${index}] caller (synthetic script): "${turn.text}"` : `  [${index}] system event: ${turn.text}${turn.dtmf ? ` (DTMF ${turn.dtmf})` : ""}`);
        await driver.sendTurn(h, turn, index);
        const t = driver.transcriptOf(h);
        const spoken = t.spoken.slice(seenSpoken);
        const tools = t.tools.slice(seenTools);
        seenSpoken = t.spoken.length;
        seenTools = t.tools.length;
        for (const tool of tools) out(`      tool ${tool.name} -> ${tool.status}${tool.reasonCode ? ` (${tool.reasonCode})` : ""}${tool.probe ? ` [hostile probe ${tool.probe}]` : ""} via ${tool.via}`);
        for (const l of spoken) out(`      caller hears (${l.templateId}, ${l.approvalStatus}${l.gate === "RENDERED" ? "" : `, gate fallback ${l.reasonCode ?? ""}`}): "${l.text ?? ""}"`);
        const backend = await driver.inspect(h);
        printSnapshot(out, backend);
        steps.push({
          turnIndex: index,
          speaker: turn.speaker,
          event: turn.speaker === "system_event" ? (turn.text.split(" ")[0] ?? null) : null,
          spoken: spoken.map((l) => ({ source: l.source, templateId: l.templateId, approvalStatus: l.approvalStatus, gate: l.gate, text: l.text })),
          tools: tools.map((x) => ({ name: x.name, status: x.status, reasonCode: x.reasonCode, probe: x.probe, via: x.via })),
          backend,
        });
      }
      await driver.endCall(h, "SCRIPT_COMPLETE");
      const raw = await driver.collectEvidence(h);
      const parsed = CallEvidence.safeParse(raw);
      evidence = parsed.success ? parsed.data : null;
    } catch {
      await driver.dispose();
    }
    const result = scoreScenario(scenario, evidence, {
      runId,
      runAt: systemClock.now().toISOString(),
      repetition: 1,
      environment: "local",
      executionMode: "local_fixture",
      missingFaultPlans: [],
      injectionFailures,
      driverError: evidence ? null : "DRIVER_ERROR",
      faultPlans: corpus.faultPlans,
    });
    const missing = evidence ? missingBackendEvidence(scenario, evidence) : ["no evidence collected"];
    const integrity = (details as { audit?: { localOk: boolean; shippedOk: boolean; findingCodes: string[]; numericOrderChainOk: boolean; events: number } } | null)?.audit ?? null;
    const outcome = (details as { outcome?: { outcome: string | null; reasonCode: string | null } } | null)?.outcome ?? null;
    out(`  -> outcome recorded by the backend: ${outcome?.outcome ?? "NONE"} (${outcome?.reasonCode ?? "—"})`);
    if (integrity) {
      out(
        `  -> audit: ${integrity.events} event(s); IntegrityVerifier ${integrity.localOk && integrity.shippedOk ? "OK" : `FAILED (${integrity.findingCodes.join(", ")})`}; numeric-order chain recomputation ${integrity.numericOrderChainOk ? "intact" : "BROKEN"}`,
      );
    }
    const failing = result.assertions.filter((a) => a.verdict !== "PASS").map((a) => `${a.assertionId}=${a.verdict}`);
    out(`  -> scorer verdict (LOCAL FIXTURE evidence): ${result.verdict}${failing.length ? ` — ${failing.join("; ")}` : ""}`);
    out(`  -> backend evidence ${missing.length === 0 ? "present" : `MISSING: ${missing.join("; ")}`}`);
    journeys.push({
      scenarioId: scenario.scenarioId,
      intent: scenario.intent,
      callId: evidence?.vendor.interactionId ?? "unknown",
      faults: [...scenario.initialState.faults],
      steps,
      final: {
        outcome: evidence?.outcome ?? null,
        outcomeReasonCode: outcome?.reasonCode ?? null,
        committedActions: (evidence?.committedActions ?? []).map((a) => ({ actionKind: a.actionKind, receiptId: a.receiptId, reconciled: a.reconciled, effectCount: a.effectCount })),
        supportRequests: (evidence?.supportRequests ?? []).map((r) => ({ kind: r.kind, referenceIssued: r.referenceIssued })),
        transfer: evidence?.transfer ? { attempted: evidence.transfer.attempted, destinationIds: evidence.transfer.destinationIds, states: evidence.transfer.states, connectionVerified: evidence.transfer.connectionVerified, fallbackInvoked: evidence.transfer.fallbackInvoked } : null,
        auditIntegrity: integrity,
        auditEventCount: (evidence?.committedState as { auditEventCount?: number } | null)?.auditEventCount ?? null,
        pinned: (evidence?.committedState as { pinned?: unknown } | null)?.pinned ?? null,
      },
      verdict: result.verdict,
      failingAssertions: failing,
      backendEvidenceComplete: missing.length === 0,
      missingEvidence: missing,
    });
  }
  const transcript: DemoTranscript = {
    label: LOCAL_FIXTURE_BADGE,
    driver: DRIVER_LABEL,
    coordinator: SIMULATED_COORDINATOR_LABEL,
    runId,
    generatedAt: systemClock.now().toISOString(),
    transport,
    journeys,
    allBackendEvidencePresent: journeys.every((j) => j.backendEvidenceComplete),
  };
  out("");
  out(`journeys: ${journeys.length}; backend evidence present for ${journeys.filter((j) => j.backendEvidenceComplete).length}; verdicts: ${["PASS", "FAIL", "INCONCLUSIVE"].map((v) => `${v}=${journeys.filter((j) => j.verdict === v).length}`).join(" ")}`);
  if (opts.write !== false) {
    const dir = join(opts.evidenceRoot ?? repoPaths().evidence, "demo");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${runId}.json`);
    writeFileSync(file, `${JSON.stringify(transcript, null, 2)}\n`, { flag: "wx" });
    out(`transcript: ${file}`);
  }
  for (const l of BADGE_LINES) out(l);
  return transcript;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const argv = process.argv.slice(2);
  const transport = argv.includes("--transport") ? (argv[argv.indexOf("--transport") + 1] as ToolTransport) : "http";
  runDemo({ faulted: argv.includes("--faulted"), transport }).then(
    (t) => {
      process.exitCode = t.allBackendEvidencePresent ? 0 : 1;
    },
    (err: unknown) => {
      console.error(err instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.message) ? err.message : "DEMO_FAILED");
      process.exitCode = 1;
    },
  );
}
