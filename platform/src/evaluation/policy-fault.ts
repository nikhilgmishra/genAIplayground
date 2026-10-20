/**
 * POLICY_ENGINE_ERROR injection point (FO-17-24.POLICY_ENGINE_ERROR; scenarios/fixtures/failures/
 * POLICY_ENGINE_ERROR.json): "the in-process OPA evaluation throws or is undefined".
 *
 * A fault-injecting decorator around the evaluation seam of a loaded, REAL OpaWasmPolicyEngine
 * (platform/src/policy/engine.ts `PolicyEvaluator`, the WASM `policy.evaluate` call). While armed, each
 * evaluation either throws (`THROW`) or returns no result set (`UNDEFINED`); everything around it is the
 * production engine: input parsing and normalisation, result validation, the invariant guard and the
 * fail-closed path that turns any evaluation error into a deny with POLICY_ENGINE_ERROR. Disarmed, every
 * call is passed to the original WASM evaluator unchanged (decisions are identical; the [FAULT] test
 * proves it).
 *
 * The in-process OPA WASM engine is an accepted Layer-2 protocol for this fault (work-packages.yaml WP-01):
 * no emulator stands in for it. The decorator counts the evaluations it faulted (`injections`), which is the
 * injector's own report; a run proves the fault was REACHED only from independent evidence: the gateway's
 * POLICY_ENGINE_ERROR tool result, its durable audit event and the engine's fail-closed log line
 * (`policy.decision.fail_closed` with detail POLICY_EVALUATION_FAILED or POLICY_RESULT_MALFORMED).
 *
 * The engine keeps its evaluator private and exposes no decoration seam yet; `install` replaces the private
 * field after checking its shape and fails loudly (POLICY_EVALUATOR_SEAM_MISSING) when the engine changes,
 * so the fault test can never pass against an engine it did not reach. A public seam on the engine
 * (policy owner) would remove the field access; recorded as an open issue of WP-01.
 */
import type { OpaWasmPolicyEngine, PolicyEvaluator } from "../policy/engine.js";

export type PolicyFaultMode = "THROW" | "UNDEFINED";

/** Message of the injected throw (never a reason code; the engine maps it to POLICY_ENGINE_ERROR itself). */
export const INJECTED_EVALUATION_ERROR = "fault injected at the OPA WASM evaluation (POLICY_ENGINE_ERROR plan)";

export class PolicyEvaluationFaultError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

interface EvaluatorHolder {
  evaluator?: unknown;
}

const isEvaluator = (x: unknown): x is PolicyEvaluator =>
  typeof x === "object" && x !== null && Array.isArray((x as PolicyEvaluator).entrypoints) && typeof (x as PolicyEvaluator).evaluate === "function";

export class PolicyEvaluationFault {
  private mode: PolicyFaultMode | null = null;
  private count = 0;
  private readonly original: PolicyEvaluator;
  private installed = true;

  private constructor(private readonly holder: EvaluatorHolder) {
    const inner = holder.evaluator;
    if (!isEvaluator(inner)) throw new PolicyEvaluationFaultError("POLICY_EVALUATOR_SEAM_MISSING");
    this.original = inner;
    const decorated: PolicyEvaluator = {
      entrypoints: inner.entrypoints,
      evaluate: (input: unknown, entrypoint: string): unknown => {
        if (this.mode === null) return inner.evaluate(input, entrypoint);
        this.count += 1;
        if (this.mode === "THROW") throw new Error(INJECTED_EVALUATION_ERROR);
        return undefined;
      },
    };
    holder.evaluator = decorated;
  }

  /** Decorates the evaluation seam of a loaded engine (disarmed until `arm`). */
  static install(engine: OpaWasmPolicyEngine): PolicyEvaluationFault {
    return new PolicyEvaluationFault(engine as unknown as EvaluatorHolder);
  }

  arm(mode: PolicyFaultMode): void {
    if (!this.installed) throw new PolicyEvaluationFaultError("POLICY_FAULT_UNINSTALLED");
    this.mode = mode;
  }

  disarm(): void {
    this.mode = null;
  }

  /** Evaluations the decorator faulted (the injector's own report, never reach evidence). */
  get injections(): number {
    return this.count;
  }

  get armed(): PolicyFaultMode | null {
    return this.mode;
  }

  /** Restores the original WASM evaluator. */
  uninstall(): void {
    this.mode = null;
    this.holder.evaluator = this.original;
    this.installed = false;
  }
}
