/**
 * LOCAL LOOPBACK load harness (SPEC-12.load smoke; NOT capacity evidence).
 *
 * Target: one LOCAL FIXTURE composition (buildContainer("local"), REAL business
 * module, PGlite in-process on a single connection) listening on 127.0.0.1 with
 * an ephemeral port. Two tool endpoints are driven over the public HTTP tool
 * route as the mcp_tools identity, each bound to a SYNTHETIC call session that
 * was set up through the public telephony-control and portal surface:
 *
 *   - PUBLIC_READ    search_approved_runbook, session at A0 (no verification);
 *   - PROTECTED_READ get_invoice_status, session verified by the LOCAL FIXTURE
 *                    secure link (synthetic client "Avery").
 *
 * The load generator (autocannon 8, test/load/autocannon-client.mjs) runs in a
 * SEPARATE Node process so it does not share the gateway's event loop. Every
 * response body is checked for ToolResult status SUCCESS. The per-integration rate
 * limiter stays in the request path with its ceiling raised (it would otherwise
 * refuse the load by design). Audit events are shipped on a real-time interval
 * while traffic runs, as the worker would.
 *
 * After the load, the FINAL SYSTEM STATE is verified: every successful response
 * has a durable audit row, the platform IntegrityVerifier checks every local
 * stream, and the hash chain is also recomputed independently in numeric
 * sequence order.
 *
 * Numbers produced here describe a developer machine on loopback. They are
 * labelled LOAD_LABEL and must never be cited as Talkdesk, PSTN or AWS capacity.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CallSession } from "../../src/evaluation/driver/call-session.js";
import { verifyAuditIntegrity } from "../../src/evaluation/driver/evidence.js";
import type { AuditIntegrity } from "../../src/evaluation/driver/evidence.js";
import { LOAD_LABEL, LOCAL_FIXTURE_BADGE } from "../../src/evaluation/driver/labels.js";
import { LocalStack } from "../../src/evaluation/driver/local-stack.js";
import { personaFor } from "../../src/evaluation/driver/personas.js";
import { LOCAL_FIXTURE_TOKENS } from "../../src/gateway/auth.js";
import { INTERACTION_ID_HEADER, SESSION_REF_HEADER } from "../../src/gateway/session-binding.js";
import { newId } from "../../src/shared/ids.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "autocannon-client.mjs");

/** Raised ceiling: the limiter still runs on every request, it just does not refuse this load. */
export const LOAD_RATE_LIMIT = { max: 10_000_000, timeWindowMs: 60_000 } as const;
/** SPEC-12 illustrative sustained tool-request target (docs/capacity-cost-model.md). */
export const TARGET_SUSTAINED_RPS = 400;

export type EndpointKey = "publicRead" | "protectedRead";

export interface LoadEndpoint {
  key: EndpointKey;
  tool: string;
  safetyClass: "PUBLIC_READ" | "PROTECTED_READ";
  sessionAssurance: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface LoadPhaseSpec {
  name: string;
  endpoint: EndpointKey;
  connections: number;
  durationS: number;
  /** Requests per second across all connections; omitted = as fast as the target answers (burst). */
  overallRate?: number;
  /**
   * Fixed number of requests; when set autocannon ignores durationS and stops after this many,
   * so a correctness smoke does not depend on how fast the machine is.
   */
  amount?: number;
}

export interface PhaseResult {
  label: string;
  url: string;
  connections: number;
  targetRate: number | null;
  durationS: number | null;
  requestsSent: number;
  responses: number;
  status2xx: number;
  non2xx: number;
  errors: number;
  timeouts: number;
  bodyChecked: number;
  bodyNotSuccess: number;
  reasonCodes: Record<string, number>;
  statusCounts: Record<string, number>;
  errorRate: number | null;
  throughputRps: number | null;
  throughputBytesPerS: number | null;
  latencyMs: { p50: number | null; p95: number | null; p99: number | null; max: number | null; mean: number | null };
  autocannonLatencyMs: { p50: number; p90: number; p99: number };
}

export interface PhaseRecord {
  name: string;
  endpoint: { tool: string; safetyClass: string; sessionAssurance: string };
  config: { connections: number; durationS: number; overallRate: number | null; amount: number | null };
  result: PhaseResult;
  /** Sustained phases only: achieved >= TARGET_SUSTAINED_RPS with zero errors (null for bursts). */
  sustainedTargetMet: boolean | null;
}

export interface FinalState {
  auditRowsBefore: number;
  auditRowsAfter: number;
  auditRowsDelta: number;
  successfulResponses: number;
  everySuccessAudited: boolean;
  auditShipRuns: number;
  /** Loop runs that threw or reported ok=false. */
  auditShipFailures: number;
  /** Loop runs in which at least one stream stopped with a reason code (shipping blocked). */
  auditShipBlockedRuns: number;
  /** Reason codes of "audit.ship.blocked" log records (content-free). */
  auditShipBlockedReasons: Record<string, number>;
  /** Unshipped audit events after the final bounded ship pass (audit_backlog_stats()). */
  auditBacklogAfterShip: number | null;
  integrity: AuditIntegrity;
}

export interface LoadEvidence {
  label: typeof LOAD_LABEL;
  badge: typeof LOCAL_FIXTURE_BADGE;
  notCapacityEvidence: true;
  runId: string;
  generatedAt: string;
  environment: "local";
  executionMode: "local_fixture";
  command: string;
  host: { node: string; platform: string; arch: string; cpus: number; cpuModel: string | null };
  target: { listener: string; database: string; transport: string; generator: string; rateLimit: typeof LOAD_RATE_LIMIT & { note: string }; auditShipIntervalMs: number };
  targetSustainedRps: number;
  phases: PhaseRecord[];
  finalState: FinalState;
  verdict: { sustainedTargetMet: boolean; zeroErrors: boolean; notes: string[] };
}

export class LoadTarget {
  private shipTimer: NodeJS.Timeout | null = null;
  private shipping = false;
  shipRuns = 0;
  shipFailures = 0;
  shipBlockedRuns = 0;

  private constructor(
    readonly stack: LocalStack,
    readonly endpoints: Record<EndpointKey, LoadEndpoint>,
    readonly shipIntervalMs: number,
  ) {}

  static async start(opts: { shipIntervalMs?: number } = {}): Promise<LoadTarget> {
    const stack = await LocalStack.create({ listen: true, rateLimit: { ...LOAD_RATE_LIMIT } });
    try {
      if (!stack.baseUrl || !stack.baseUrl.startsWith("http://127.0.0.1:")) throw new Error("LOOPBACK_REQUIRED");
      const base = { initialState: { fixtureSet: "synthetic_world_v1", faults: [] as string[] } };
      // PUBLIC_READ: an A0 call session (consent granted, no verification).
      const pub = new CallSession(stack, personaFor({ ...base, audience: "client", intent: "faq_hours" }), "en-US");
      if (!(await pub.start({ recording: "GRANTED", automatedProcessing: "GRANTED" }, false))) throw new Error("LOAD_SETUP_PUBLIC_SESSION_FAILED");
      // PROTECTED_READ: the synthetic client verified through the LOCAL FIXTURE secure link.
      const prot = new CallSession(stack, personaFor({ ...base, audience: "client", intent: "invoice_explanation" }), "en-US");
      if (!(await prot.start({ recording: "GRANTED", automatedProcessing: "GRANTED" }, false))) throw new Error("LOAD_SETUP_PROTECTED_SESSION_FAILED");
      await prot.selectRole("client");
      const l = prot.persona.locator;
      const begin = await prot.tool("begin_verification", {
        method: "SECURE_LINK",
        locator: l.kind === "NAME_AND_DATE_OF_BIRTH" ? { kind: l.kind, fullName: l.fullName, dateOfBirth: l.dateOfBirth } : { kind: l.kind, hint: l.hint },
      });
      if (begin?.status !== "SUCCESS" || !(await prot.approveSecureLink({ matchCodeConfirmed: true, idpAvailable: true }))) throw new Error("LOAD_SETUP_VERIFICATION_FAILED");
      const probe = await prot.tool("get_invoice_status", { invoiceId: null, detail: "BALANCE", serviceDate: null });
      if (probe?.status !== "SUCCESS") throw new Error("LOAD_SETUP_PROTECTED_READ_FAILED");
      const ctx = await prot.refreshContext();
      const endpoint = (key: EndpointKey, tool: string, safetyClass: LoadEndpoint["safetyClass"], s: CallSession, args: Record<string, unknown>, assurance: string): LoadEndpoint => ({
        key,
        tool,
        safetyClass,
        sessionAssurance: assurance,
        url: `${stack.baseUrl}/v1/tools/${tool}/1.0.0`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${LOCAL_FIXTURE_TOKENS.mcp_tools}`,
          [SESSION_REF_HEADER]: s.sessionRef ?? "",
          [INTERACTION_ID_HEADER]: s.callId,
        },
        body: JSON.stringify({ arguments: args }),
      });
      const target = new LoadTarget(
        stack,
        {
          publicRead: endpoint("publicRead", "search_approved_runbook", "PUBLIC_READ", pub, { intent: "human_request", query: null, language: "en" }, "A0"),
          protectedRead: endpoint("protectedRead", "get_invoice_status", "PROTECTED_READ", prot, { invoiceId: null, detail: "BALANCE", serviceDate: null }, ctx?.assurance ?? prot.maxAssurance),
        },
        opts.shipIntervalMs ?? 1_000,
      );
      return target;
    } catch (err) {
      await stack.close();
      throw err;
    }
  }

  /** Ships audit events on a real-time interval (never overlapping), as the worker's audit.ship loop would. */
  startAuditShipping(): void {
    if (this.shipTimer) return;
    this.shipTimer = setInterval(() => {
      if (this.shipping) return;
      this.shipping = true;
      this.ship()
        .then(() => undefined)
        .catch(() => {
          this.shipFailures += 1;
        })
        .finally(() => {
          this.shipping = false;
        });
    }, this.shipIntervalMs);
  }

  /** One audit.ship run; returns the number of events shipped. */
  async ship(): Promise<number> {
    try {
      const r = await this.stack.runLoopOnce("audit.ship");
      this.shipRuns += 1;
      if (!r.ok) this.shipFailures += 1;
      if (Number(r.details.streamsWithReason ?? 0) > 0) this.shipBlockedRuns += 1;
      return r.processed;
    } catch {
      this.shipFailures += 1;
      return 0;
    }
  }

  /** Ships until a run ships nothing (bounded). */
  async shipAll(maxRuns = 200): Promise<void> {
    for (let i = 0; i < maxRuns; i++) if ((await this.ship()) === 0) return;
  }

  blockedReasons(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.stack.logRecords) {
      if (r.event !== "audit.ship.blocked") continue;
      const code = typeof r.fields.reasonCode === "string" ? r.fields.reasonCode : "UNKNOWN";
      out[code] = (out[code] ?? 0) + 1;
    }
    return out;
  }

  async stopAuditShipping(): Promise<void> {
    if (this.shipTimer) clearInterval(this.shipTimer);
    this.shipTimer = null;
    while (this.shipping) await new Promise((r) => setTimeout(r, 10));
  }

  async auditRows(): Promise<number> {
    return this.stack.container.db.tx(async (tx) => Number((await tx.query<{ n: number }>("select count(*)::int as n from audit_outbox")).rows[0]?.n ?? 0), { role: "app_worker" });
  }

  async auditBacklog(): Promise<number | null> {
    try {
      return await this.stack.container.db.tx(async (tx) => {
        const row = (await tx.query<{ backlog_count: unknown }>("select * from audit_backlog_stats()")).rows[0];
        return row ? Number(row.backlog_count) : null;
      }, { role: "app_worker" });
    } catch {
      return null;
    }
  }

  /** Ships everything outstanding (bounded), then verifies the final audit state. */
  async finalState(before: number, successfulResponses: number): Promise<FinalState> {
    await this.stopAuditShipping();
    // Requests still in flight when the generator stopped finish on the server; let them land.
    await new Promise((r) => setTimeout(r, 1_500));
    await this.shipAll();
    const after = await this.auditRows();
    const { integrity } = await verifyAuditIntegrity(this.stack);
    return {
      auditRowsBefore: before,
      auditRowsAfter: after,
      auditRowsDelta: after - before,
      successfulResponses,
      everySuccessAudited: after - before >= successfulResponses,
      auditShipRuns: this.shipRuns,
      auditShipFailures: this.shipFailures,
      auditShipBlockedRuns: this.shipBlockedRuns,
      auditShipBlockedReasons: this.blockedReasons(),
      auditBacklogAfterShip: await this.auditBacklog(),
      integrity,
    };
  }

  async close(): Promise<void> {
    await this.stopAuditShipping();
    await this.stack.close();
  }
}

/** Runs one autocannon phase in a child process and returns its summary (never the response bodies). */
export function runPhase(target: LoadTarget, spec: LoadPhaseSpec): Promise<PhaseRecord> {
  const ep = target.endpoints[spec.endpoint];
  const cfg = {
    label: spec.name,
    url: ep.url,
    headers: ep.headers,
    body: ep.body,
    connections: spec.connections,
    durationS: spec.durationS,
    ...(spec.overallRate ? { overallRate: spec.overallRate } : {}),
    ...(spec.amount ? { amount: spec.amount } : {}),
    timeoutS: 10,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT, JSON.stringify(cfg)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").at(-1) ?? "";
      const parsed = parseSummary(line);
      if (code !== 0 || !parsed || "error" in parsed) {
        reject(new Error(`LOAD_CLIENT_FAILED:${code}:${parsed && "error" in parsed ? parsed.error : err.slice(0, 200)}`));
        return;
      }
      const sustained = spec.overallRate !== undefined && spec.name.startsWith("sustained.");
      resolve({
        name: spec.name,
        endpoint: { tool: ep.tool, safetyClass: ep.safetyClass, sessionAssurance: ep.sessionAssurance },
        config: { connections: spec.connections, durationS: spec.durationS, overallRate: spec.overallRate ?? null, amount: spec.amount ?? null },
        result: parsed,
        sustainedTargetMet: sustained ? (parsed.throughputRps ?? 0) >= TARGET_SUSTAINED_RPS && parsed.errorRate === 0 : null,
      });
    });
  });
}

function parseSummary(line: string): PhaseResult | { error: string } | null {
  try {
    return JSON.parse(line) as PhaseResult | { error: string };
  } catch {
    return null;
  }
}

export function phaseClean(p: PhaseRecord): boolean {
  const r = p.result;
  return r.responses > 0 && r.errors === 0 && r.timeouts === 0 && r.non2xx === 0 && r.bodyNotSuccess === 0;
}

/** Runs the phases in order against one target and assembles the labelled evidence record. */
export async function runLoadCampaign(opts: { phases: readonly LoadPhaseSpec[]; command: string; warmupS?: number }): Promise<LoadEvidence> {
  const target = await LoadTarget.start();
  try {
    if (opts.warmupS && opts.warmupS > 0) {
      for (const key of ["publicRead", "protectedRead"] as const) await runPhase(target, { name: `warmup.${key}`, endpoint: key, connections: 10, durationS: opts.warmupS });
    }
    await target.shipAll();
    const before = await target.auditRows();
    target.startAuditShipping();
    const phases: PhaseRecord[] = [];
    for (const spec of opts.phases) phases.push(await runPhase(target, spec));
    const successes = phases.reduce((n, p) => n + p.result.status2xx - p.result.bodyNotSuccess, 0);
    const finalState = await target.finalState(before, successes);
    const sustained = phases.filter((p) => p.sustainedTargetMet !== null);
    const zeroErrors = phases.every(phaseClean);
    const notes: string[] = [];
    for (const p of sustained) {
      if (!p.sustainedTargetMet) notes.push(`${p.name}: achieved ${p.result.throughputRps} req/s against the ${TARGET_SUSTAINED_RPS} req/s target (error rate ${p.result.errorRate})`);
    }
    if (!finalState.everySuccessAudited) notes.push(`audit rows grew by ${finalState.auditRowsDelta} for ${successes} successful responses`);
    if (finalState.auditShipBlockedRuns > 0) notes.push(`audit shipping blocked in ${finalState.auditShipBlockedRuns} of ${finalState.auditShipRuns} runs (${Object.keys(finalState.auditShipBlockedReasons).join(",") || "reason not logged"}); ${finalState.auditBacklogAfterShip} events unshipped after the final pass (platform/src/audit/shipper.ts ORDER BY defect)`);
    if (!finalState.integrity.localOk) notes.push(`IntegrityVerifier reported ${finalState.integrity.findingCodes.join(",") || "findings"}; numeric-order chain recomputation ok=${finalState.integrity.numericOrderChainOk} (platform/src/audit/verifier.ts ORDER BY defect)`);
    const cpu = cpus();
    return {
      label: LOAD_LABEL,
      badge: LOCAL_FIXTURE_BADGE,
      notCapacityEvidence: true,
      runId: newId("run").replace(/^run_/, "run_load_"),
      generatedAt: new Date().toISOString(),
      environment: "local",
      executionMode: "local_fixture",
      command: opts.command,
      host: { node: process.version, platform: platform(), arch: arch(), cpus: cpu.length, cpuModel: cpu[0]?.model ?? null },
      target: {
        listener: "127.0.0.1 (ephemeral port, loopback only)",
        database: "PGlite 0.3.15 in-process (WASM), single connection, same thread as the gateway",
        transport: "HTTP tool route POST /v1/tools/:name/1.0.0 on the Fastify listener (mcp_tools LOCAL FIXTURE token, trusted session headers)",
        generator: "autocannon 8.0.0 in a separate Node process",
        rateLimit: { ...LOAD_RATE_LIMIT, note: "per-integration limiter active with a raised ceiling; the default limit would refuse this load by design" },
        auditShipIntervalMs: target.shipIntervalMs,
      },
      targetSustainedRps: TARGET_SUSTAINED_RPS,
      phases,
      finalState,
      verdict: { sustainedTargetMet: sustained.length > 0 && sustained.every((p) => p.sustainedTargetMet === true), zeroErrors, notes },
    };
  } finally {
    await target.close();
  }
}

/** Writes evidence/load/<runId>.json exclusively (never overwrites a previous run). */
export function writeLoadEvidence(evidence: LoadEvidence, evidenceRoot: string): string {
  const dir = join(evidenceRoot, "load");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${evidence.runId}.json`);
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  return path;
}

/**
 * Long-run phases (scripts/load/run-local-load.mts): an unsaturated low-rate reference per endpoint
 * (latency without queueing), then >= 20 s sustained at the target rate per endpoint, then a short burst.
 * Low-rate reference phases are not sustained-target phases (sustainedTargetMet stays null).
 */
export function campaignPhases(opts: { sustainedS: number; burstS: number; sustainedConnections: number; burstConnections: number; rate: number; referenceRate?: number; referenceS?: number }): LoadPhaseSpec[] {
  const ref: LoadPhaseSpec[] =
    opts.referenceRate && opts.referenceS
      ? [
          { name: "reference.public_read", endpoint: "publicRead", connections: 4, durationS: opts.referenceS, overallRate: opts.referenceRate },
          { name: "reference.protected_read", endpoint: "protectedRead", connections: 4, durationS: opts.referenceS, overallRate: opts.referenceRate },
        ]
      : [];
  return [
    ...ref,
    { name: "sustained.public_read", endpoint: "publicRead", connections: opts.sustainedConnections, durationS: opts.sustainedS, overallRate: opts.rate },
    { name: "sustained.protected_read", endpoint: "protectedRead", connections: opts.sustainedConnections, durationS: opts.sustainedS, overallRate: opts.rate },
    { name: "burst.public_read", endpoint: "publicRead", connections: opts.burstConnections, durationS: opts.burstS },
    { name: "burst.protected_read", endpoint: "protectedRead", connections: opts.burstConnections, durationS: opts.burstS },
  ];
}
