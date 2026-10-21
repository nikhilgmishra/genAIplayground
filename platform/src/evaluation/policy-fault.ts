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
 * `install` uses the engine's public, documented decoration seam (`OpaWasmPolicyEngine.decorateEvaluator`,
 * platform/src/policy/engine.ts): local/ci only (the engine refuses it for any other environment, and on an
 * engine loaded for a deployed environment), tighten-only (a decorated allow wider than the loaded policy is
 * a POLICY_ENGINE_ERROR deny). It fails loudly (POLICY_EVALUATOR_SEAM_MISSING) when the object it is given
 * has no such seam, so the fault test can never pass against an engine it did not reach.
 */
import type { EvaluatorDecoration, OpaWasmPolicyEngine, PolicyEvaluator } from "../policy/engine.js";
import type { Environment } from "../protocol/index.js";

export type PolicyFaultMode = "THROW" | "UNDEFINED";

/** Message of the injected throw (never a reason code; the engine maps it to POLICY_ENGINE_ERROR itself). */
export const INJECTED_EVALUATION_ERROR = "fault injected at the OPA WASM evaluation (POLICY_ENGINE_ERROR plan)";

export class PolicyEvaluationFaultError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

export class PolicyEvaluationFault {
  private mode: PolicyFaultMode | null = null;
  private count = 0;
  private installed = true;
  private readonly decoration: EvaluatorDecoration;

  private constructor(engine: OpaWasmPolicyEngine, opts: { environment: Environment }) {
    if (typeof (engine as { decorateEvaluator?: unknown } | null)?.decorateEvaluator !== "function") {
      throw new PolicyEvaluationFaultError("POLICY_EVALUATOR_SEAM_MISSING");
    }
    this.decoration = engine.decorateEvaluator(
      (inner: PolicyEvaluator): PolicyEvaluator => ({
        entrypoints: inner.entrypoints,
        evaluate: (input: unknown, entrypoint: string): unknown => {
          if (this.mode === null) return inner.evaluate(input, entrypoint);
          this.count += 1;
          if (this.mode === "THROW") throw new Error(INJECTED_EVALUATION_ERROR);
          return undefined;
        },
      }),
      opts,
    );
  }

  /** Decorates the evaluation seam of a loaded engine (disarmed until `arm`); local/ci only. */
  static install(engine: OpaWasmPolicyEngine, opts: { environment: Environment }): PolicyEvaluationFault {
    return new PolicyEvaluationFault(engine, opts);
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
    this.decoration.remove();
    this.installed = false;
  }
}
