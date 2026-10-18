import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowStateName } from "../protocol/index.js";
import { sha256Hex } from "../shared/canonical.js";
import { ASL_PLACEHOLDERS, buildAslFiles, generateAsl, heartbeatFor, RETRYABLE_ERROR, type AslManifest, type AslStateMachine } from "./asl.js";
import { SHIPPED_DEFINITIONS } from "./definitions/index.js";
import { durationSeconds } from "./duration.js";
import { checkAslDrift, DEFAULT_ASL_DIR, latestDefinitions, runGenerateAsl, writeAslFiles } from "./generate-asl.js";
import { POLICY_CHANGED_PENDING_ACTION, type VersionedWorkflowDefinition } from "./types.js";

type AslValidator = (definition: unknown, opts?: { checkPaths: boolean; checkArn: boolean }) => {
  isValid: boolean;
  errorsText: (sep?: string) => string;
};
const aslValidator = createRequire(import.meta.url)("asl-validator") as AslValidator;

type State = Record<string, unknown>;
const states = (doc: AslStateMachine) => doc.States as Record<string, State>;

function stringLeaves(value: unknown, path: string[] = []): { path: string[]; value: string }[] {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, [...path, String(i)]));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, [...path, k]));
  return [];
}

function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)]);
  return [];
}

const docs = SHIPPED_DEFINITIONS.map((d) => ({ def: d, doc: generateAsl(d) }));

/** Event a route choice accepts (And[0]) and the actor kinds it accepts (And[1]: one comparison or an Or). */
const choiceEvent = (c: State): string | undefined => ((c.And as State[] | undefined)?.[0]?.StringEquals as string | undefined) ?? undefined;
function choiceActors(c: State): string[] {
  const actor = (c.And as State[] | undefined)?.[1];
  if (!actor) return [];
  if (Array.isArray(actor.Or)) return (actor.Or as State[]).map((x) => String(x.StringEquals)).sort();
  return [String(actor.StringEquals)];
}
const routableEvents = (def: VersionedWorkflowDefinition, s: { transitions: Partial<Record<string, string>> }): string[] =>
  Object.keys(s.transitions)
    .filter((e) => (def.eventActors[e] ?? []).length > 0)
    .sort();

describe("ASL generation for Step Functions STANDARD", () => {
  it("[SPEC-3.stepfunctions] every generated ASL document validates with asl-validator (paths and ARNs checked)", () => {
    for (const { def, doc } of docs) {
      const r = aslValidator(structuredClone(doc), { checkPaths: true, checkArn: true });
      expect(r.isValid, `${def.type}: ${r.errorsText("; ")}`).toBe(true);
    }
  });

  it("[SPEC-3.stepfunctions] the manifest declares STANDARD for every workflow and pins each document digest", () => {
    const files = buildAslFiles(latestDefinitions());
    const manifest = JSON.parse(files.get("manifest.json") ?? "{}") as AslManifest;
    expect(manifest.stateMachineType).toBe("STANDARD");
    expect(manifest.logging).toEqual({ level: "ERROR", includeExecutionData: false });
    expect(manifest.workflows).toHaveLength(SHIPPED_DEFINITIONS.length);
    for (const w of manifest.workflows) {
      expect(w.stateMachineType).toBe("STANDARD");
      expect(sha256Hex(files.get(w.file) ?? "")).toBe(w.sha256);
    }
    for (const { doc } of docs) {
      expect(doc.Comment).toContain("STANDARD");
      // No EXPRESS-only constructs (e.g. distributed Map in EXPRESS mode) are emitted.
      expect(JSON.stringify(doc)).not.toContain("EXPRESS");
    }
  });

  it("[SPEC-9.workflow] each nonterminal state waits on a waitForTaskToken Task with TimeoutSeconds from its deadline", () => {
    for (const { def, doc } of docs) {
      for (const [name, s] of Object.entries(def.states)) {
        if (!s) continue;
        const t = states(doc)[name];
        if (s.terminal) {
          expect(t?.Type).toBe(name === "FAILED" ? "Fail" : "Succeed");
          continue;
        }
        expect(t).toMatchObject({ Type: "Task", Resource: "arn:aws:states:::sqs:sendMessage.waitForTaskToken" });
        const timeout = durationSeconds(s.deadline ?? "");
        expect(t?.TimeoutSeconds).toBe(timeout);
        expect(t?.HeartbeatSeconds).toBe(heartbeatFor(timeout));
        expect(Number(t?.HeartbeatSeconds)).toBeLessThan(timeout);
        const body = (t?.Parameters as State).MessageBody as State;
        expect(body.ownerQueue).toBe(s.owner);
        if (s.humanTask) expect(body.taskType).toBe(s.humanTask.taskType);
      }
    }
  });

  it("[SPEC-9.workflow] Retry MaxAttempts equals the state's retry budget with FULL jitter and backoff; Catch routes to escalation", () => {
    for (const { def, doc } of docs) {
      for (const [name, s] of Object.entries(def.states)) {
        if (!s || s.terminal) continue;
        const t = states(doc)[name] as State;
        const retry = (t.Retry as State[])[0] as State;
        expect(retry).toMatchObject({ ErrorEquals: [RETRYABLE_ERROR], MaxAttempts: s.retryBudget, JitterStrategy: "FULL", BackoffRate: 2 });
        expect(Number(retry.IntervalSeconds)).toBeGreaterThan(0);
        const catches = t.Catch as State[];
        expect(catches.map((c) => c.Next)).toEqual([`${name}__DeadlineEscalation`, `${name}__FailureEscalation`]);
        for (const esc of [`${name}__DeadlineEscalation`, `${name}__FailureEscalation`, `${name}__InvalidSignalEscalation`]) {
          const pass = states(doc)[esc] as State;
          expect(pass.Type).toBe("Pass");
          expect((pass.Result as State).event).toBe(s.escalation?.event);
          // Escalation is a system action, and the validator requires "system" in the escalation event's actor set.
          expect((pass.Result as State).actorKind).toBe("system");
          expect(def.eventActors[s.escalation?.event ?? ""]).toContain("system");
          expect(pass.Next).toBe(`${name}__NotifyEscalation`);
        }
        const notify = states(doc)[`${name}__NotifyEscalation`] as State;
        expect((notify.Parameters as State).QueueUrl).toBe("${escalation_queue_url}");
        expect(((notify.Parameters as State).MessageBody as State).escalationOwnerQueue).toBe(s.escalation?.ownerQueue);
        // A failed escalation notice never blocks the escalation itself.
        expect((notify.Catch as State[])[0]?.Next).toBe(`${name}__Route`);
      }
    }
  });

  it("[SPEC-9.workflow] the Choice route covers every declared transition that an actor may send, and defaults to escalation", () => {
    for (const { def, doc } of docs) {
      for (const [name, s] of Object.entries(def.states)) {
        if (!s || s.terminal) continue;
        const route = states(doc)[`${name}__Route`] as State;
        expect(route.Type).toBe("Choice");
        expect(route.Default).toBe(`${name}__InvalidSignalEscalation`);
        const choices = route.Choices as State[];
        const routed = choices.map(choiceEvent).filter((e): e is string => e !== undefined);
        expect(routed.sort()).toEqual(routableEvents(def, s));
        expect(routed).not.toContain("RETRYABLE_FAILURE");
        // Engine-raised policy-change events are never accepted from a worker answer.
        expect(routed).not.toContain(POLICY_CHANGED_PENDING_ACTION);
        // A missing event or actor kind escalates.
        expect(choices.filter((c) => "Not" in c).map((c) => (c.Not as State).Variable)).toEqual(["$.signal.event", "$.signal.actorKind"]);
      }
    }
  });

  it("[SPEC-9.workflow][AUTH-03] each routed event is accepted only from the actor kinds the definition declares for it", () => {
    let checked = 0;
    for (const { def, doc } of docs) {
      for (const [name, s] of Object.entries(def.states)) {
        if (!s || s.terminal) continue;
        for (const c of (states(doc)[`${name}__Route`] as State).Choices as State[]) {
          const event = choiceEvent(c);
          if (event === undefined) continue;
          expect(choiceActors(c), `${def.type}.${name}.${event}`).toEqual([...(def.eventActors[event] ?? [])].sort());
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
    // Human decisions are staff-only; a caller can never report SYSTEM_CONFIRMED.
    const billing = docs.find((d) => d.def.type === "billing_dispute_review")?.doc as AslStateMachine;
    const sys = ((states(billing).WAITING_FOR_SYSTEM__Route as State).Choices as State[]).find((c) => choiceEvent(c) === "SYSTEM_CONFIRMED") as State;
    expect(choiceActors(sys)).toEqual(["external_system", "system"]);
    const human = ((states(billing).WAITING_FOR_HUMAN__Route as State).Choices as State[]).find((c) => choiceEvent(c) === "HUMAN_APPROVED") as State;
    expect(choiceActors(human)).toEqual(["staff"]);
  });

  it("[SPEC-9.task-token] no task token appears in any URL-like string; queue URLs are static Terraform placeholders", () => {
    for (const { doc } of docs) {
      expect(keys(doc).filter((k) => /url/i.test(k) && k.endsWith(".$"))).toEqual([]);
      for (const leaf of stringLeaves(doc)) {
        const key = leaf.path.at(-1) ?? "";
        const urlLike = /url|uri|endpoint|link/i.test(key) || /:\/\/|^\$\{[a-z_]+_url\}$/.test(leaf.value);
        if (urlLike) {
          expect(leaf.value).not.toMatch(/task.?token/i);
          expect(leaf.value).toMatch(/^\$\{[a-z_]+_url\}$/);
        }
        if (/Task\.Token/.test(leaf.value)) {
          // The token is only ever placed in an SQS message body field.
          expect(leaf.path).toContain("MessageBody");
          expect(key).toBe("taskToken.$");
        }
      }
      expect(JSON.stringify(doc)).not.toMatch(/https?:\/\//);
    }
  });

  it("[SPEC-9.workflow][DATA-01] execution data carries only opaque references (ResultSelector/ResultPath keep payloads out)", () => {
    const allowedPaths = new Set(["$.workflowId", "$.tenantId", "$$.Task.Token", "$.event", "$.actorKind", "$.decision", "$.signal.cause"]);
    for (const { doc } of docs) {
      for (const leaf of stringLeaves(doc)) {
        if ((leaf.path.at(-1) ?? "").endsWith(".$")) expect(allowedPaths.has(leaf.value), leaf.value).toBe(true);
      }
      for (const s of Object.values(states(doc))) {
        expect(s.InputPath).toBeUndefined();
        expect(s.OutputPath).toBeUndefined();
        if (s.Type === "Task" && s.Resource === "arn:aws:states:::sqs:sendMessage.waitForTaskToken") {
          expect(["$.signal", "$.recheck"]).toContain(s.ResultPath);
          // Signals keep exactly {event, actorKind}; rechecks keep exactly {decision}.
          expect(Object.keys(s.ResultSelector as State).sort()).toEqual(s.ResultPath === "$.signal" ? ["actorKind.$", "event.$"] : ["decision.$"]);
        }
      }
    }
  });

  it("[SPEC-9.recheck] guarded transitions route through a recheck task that proceeds only on an explicit ALLOW and fails closed", () => {
    let guarded = 0;
    for (const { def, doc } of docs) {
      for (const [state, byEvent] of Object.entries(def.transitionGuards)) {
        for (const [event, guard] of Object.entries(byEvent ?? {})) {
          guarded++;
          const s = def.states[state as WorkflowStateName];
          const route = states(doc)[`${state}__Route`] as State;
          const choice = (route.Choices as State[]).find((c) => choiceEvent(c) === event);
          expect(choice?.Next).toBe(`${state}__Recheck_${event}`);
          const recheck = states(doc)[`${state}__Recheck_${event}`] as State;
          expect((recheck.Parameters as State).QueueUrl).toBe("${recheck_queue_url}");
          expect(((recheck.Parameters as State).MessageBody as State).guard).toBe(guard);
          expect((recheck.Catch as State[])[0]?.Next).toBe(`${state}__FailureEscalation`);
          const decision = states(doc)[`${state}__Recheck_${event}__Decision`] as State;
          expect(decision.Default).toBe(s?.transitions[POLICY_CHANGED_PENDING_ACTION]);
          const allow = (decision.Choices as State[]).find((c) => c.StringEquals === "ALLOW");
          expect(allow?.Next).toBe(s?.transitions[event]);
        }
      }
    }
    expect(guarded).toBeGreaterThan(0);
  });

  it("[SPEC-9.workflow][AUTH-03] property: walking the ASL with worker answers reaches the same states as the versioned definition, and a non-permitted actor escalates", () => {
    // Minimal Step Functions walk: Task -> Route(Choice on $.signal.event + $.signal.actorKind) -> [Recheck -> Decision(ALLOW)] -> next state.
    const step = (doc: AslStateMachine, from: string, event: string, actorKind: string): string => {
      const route = states(doc)[`${from}__Route`] as State;
      const c = (route.Choices as State[]).find((x) => choiceEvent(x) === event && choiceActors(x).includes(actorKind));
      let next = String(c?.Next ?? route.Default);
      if (next.includes("__Recheck_")) {
        const decision = states(doc)[`${next}__Decision`] as State;
        next = String((decision.Choices as State[]).find((x) => x.StringEquals === "ALLOW")?.Next);
      }
      return next;
    };
    const ALL_KINDS = ["caller", "system", "staff", "external_system"];
    fc.assert(
      fc.property(fc.constantFrom(...docs), fc.array(fc.tuple(fc.nat(50), fc.nat(3)), { maxLength: 30 }), ({ def, doc }, picks) => {
        let cur: WorkflowStateName = def.initial;
        expect(doc.StartAt).toBe(cur);
        for (const [p, k] of picks) {
          const s = def.states[cur];
          if (!s || s.terminal) break;
          const events = routableEvents(def, s);
          const event = events[p % events.length] as string;
          const permitted = def.eventActors[event] ?? [];
          const forbidden = ALL_KINDS.filter((x) => !permitted.includes(x as never));
          for (const bad of forbidden) expect(step(doc, cur, event, bad)).toBe(`${cur}__InvalidSignalEscalation`);
          const actor = permitted[k % permitted.length] as string;
          const expected = s.transitions[event] as WorkflowStateName;
          expect(step(doc, cur, event, actor)).toBe(expected);
          cur = expected;
        }
      }),
      { numRuns: 300 },
    );
  });

  it("[SPEC-3.stepfunctions] the documents use exactly the documented Terraform placeholders", () => {
    const used = new Set<string>();
    for (const { doc } of docs) for (const m of JSON.stringify(doc).matchAll(/\$\{([a-z_]+)\}/g)) used.add(m[1] as string);
    expect([...used].sort()).toEqual(Object.keys(ASL_PLACEHOLDERS).sort());
    const readme = readFileSync(join(DEFAULT_ASL_DIR, "README.md"), "utf8");
    for (const p of Object.keys(ASL_PLACEHOLDERS)) expect(readme).toContain(`\${${p}}`);
  });

  it("[SPEC-9.workflow] generation rejects a definition whose guard has no policy-change route", () => {
    const broken = structuredClone(SHIPPED_DEFINITIONS[0]) as VersionedWorkflowDefinition;
    const ready = broken.states.READY_TO_COMMIT;
    if (!ready) throw new Error("fixture definition incomplete");
    delete ready.transitions.POLICY_CHANGED_PENDING_ACTION;
    expect(() => generateAsl(broken)).toThrow("GUARD_ROUTE_MISSING");
  });
});

describe("ASL drift check", () => {
  it("[SPEC-3.stepfunctions] the committed infra/stepfunctions documents match the generator output", () => {
    const err: string[] = [];
    const code = runGenerateAsl(["--check"], { out: () => undefined, err: (l) => err.push(l) });
    expect(err).toEqual([]);
    expect(code).toBe(0);
  });

  it("[SPEC-3.stepfunctions] --check exits non-zero on modified, missing or unexpected generated files", () => {
    const dir = mkdtempSync(join(tmpdir(), "vsp-asl-"));
    try {
      const files = buildAslFiles(latestDefinitions());
      writeAslFiles(dir, files);
      expect(checkAslDrift(dir, files)).toEqual([]);
      writeFileSync(join(dir, "complaint_review.asl.json"), "{}\n");
      unlinkSync(join(dir, "callback_request.asl.json"));
      writeFileSync(join(dir, "retired_workflow.asl.json"), "{}\n");
      writeFileSync(join(dir, "README.md"), "not generated\n");
      expect(checkAslDrift(dir, files)).toEqual([
        "MISSING:callback_request.asl.json",
        "MODIFIED:complaint_review.asl.json",
        "UNEXPECTED:retired_workflow.asl.json",
      ]);
      const err: string[] = [];
      expect(runGenerateAsl(["--check", "--out", dir], { out: () => undefined, err: (l) => err.push(l) })).toBe(1);
      expect(err.some((l) => l.startsWith("asl.drift"))).toBe(true);
      expect(runGenerateAsl(["--out", dir], { out: () => undefined, err: () => undefined })).toBe(0);
      unlinkSync(join(dir, "retired_workflow.asl.json"));
      expect(runGenerateAsl(["--check", "--out", dir], { out: () => undefined, err: () => undefined })).toBe(0);
      expect(runGenerateAsl(["--out"], { out: () => undefined, err: () => undefined })).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
