/**
 * In-process OPA policy engine (ADR-0002): evaluates the WebAssembly bundle
 * built by `scripts/policy.sh build` beside the tool service.
 *
 * Guarantees:
 *  - decide()/decideConsole() NEVER throw. Invalid input -> deny
 *    POLICY_INPUT_INVALID; any evaluation error or malformed result -> deny
 *    POLICY_ENGINE_ERROR (fail closed, spec section 3 / ADR-0002).
 *  - Input is strictly parsed with the protocol PolicyInput schema first, so a
 *    model-proposed field (e.g. "callerClaimedRole") makes the request invalid
 *    rather than influencing the decision (AUTH-03).
 *  - What is evaluated is read from bundle.tar.gz itself, so `bundleDigest`
 *    (sha256 of that artifact) and `policyVersion` (manifest revision, from
 *    policy/VERSION) identify exactly the policy that decided (OPS-06).
 *  - A TypeScript invariant guard can only TIGHTEN a WASM decision: an allow
 *    for an expired/revoked session, a tenant mismatch, an engaged AI-admission
 *    switch or a verification-secret resource is converted to a deny.
 *  - A fault-injection decoration of the evaluator (local/ci only) can only
 *    tighten too: a decorated allow wider than the loaded policy's own decision
 *    for the engine's own (never shared) input is a POLICY_ENGINE_ERROR deny
 *    (decorateEvaluator).
 *
 * Kind: "live" — this is the real engine over the real bundle. A bundle built
 * locally is NOT an approved policy release (POLICY_RELEASE, PRQ-031).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "@open-policy-agent/opa-wasm";
import { z } from "zod";
import { silentLogger } from "../observability/logger.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { VersionLabel } from "../protocol/common.js";
import type { Environment } from "../protocol/common.js";
import { PolicyDecision, PolicyInput } from "../protocol/policy.js";
import { ReasonCode } from "../protocol/tools.js";
import { sha256Hex } from "../shared/canonical.js";
import { systemClock, type Clock } from "../shared/clock.js";
import { PlatformError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { PolicyBundleData, PolicyObligation, isAlwaysAvailableAction, type PolicyCatalogue } from "./catalogue.js";
import { ConsoleDecision, ConsoleDecisionInput, RegoConsoleDecision } from "./console.js";
import type { PolicyEngine } from "./ports.js";
import { BundleArchiveError, readTarGz } from "./tar.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Repository root (policy/ lives here). */
export const REPO_ROOT = resolve(here, "../../..");
export const POLICY_ROOT = join(REPO_ROOT, "policy");
/** Default output directory of `scripts/policy.sh build`. */
export const DEFAULT_BUNDLE_DIR = join(POLICY_ROOT, "build");

export const AUTHZ_ENTRYPOINT = "vsp/authz/decision";
export const CONSOLE_ENTRYPOINT = "vsp/console/decision";

/** Largest serialized PolicyInput accepted (the strict schema bounds arrays; this bounds strings too). */
export const MAX_POLICY_INPUT_BYTES = 64 * 1024;
/** WebAssembly memory bounds (64 KiB pages): 512 KiB initial, 64 MiB maximum. */
const WASM_MEMORY = { initial: 8, maximum: 1024 } as const;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_REASON_CODES = 16;

export class PolicyBundleLoadError extends PlatformError {}

export const BundleManifest = z.object({
  revision: VersionLabel,
  roots: z.array(z.string()),
  wasm: z.array(z.strictObject({ entrypoint: z.string(), module: z.string() })).min(1),
  rego_version: z.number().int().optional(),
});
export type BundleManifest = z.infer<typeof BundleManifest>;

/** Raw Rego output for the authz entrypoint (before the engine adds identity fields). */
export const RegoAuthzDecision = z.strictObject({
  allow: z.boolean(),
  reasonCodes: z.array(ReasonCode).min(1).max(64),
  fieldMask: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{0,80}$/)).max(64),
  obligations: z.array(PolicyObligation).max(8),
});
export type RegoAuthzDecision = z.infer<typeof RegoAuthzDecision>;

/** Narrow evaluation seam: the WASM policy in production, a stub in fault-injection tests. */
export interface PolicyEvaluator {
  readonly entrypoints: readonly string[];
  evaluate(input: unknown, entrypoint: string): unknown;
}

/**
 * Handle of an evaluator decoration installed with `OpaWasmPolicyEngine.decorateEvaluator`
 * (FAULT-INJECTION SEAM, see the method). `remove()` restores the evaluator that was decorated;
 * it is idempotent.
 */
export interface EvaluatorDecoration {
  readonly active: boolean;
  remove(): void;
}

/** Reason-coded refusal of the evaluator decoration seam (never an evaluation error). */
export class PolicyEvaluatorSeamError extends PlatformError {}

export interface EngineOptions {
  clock?: Clock;
  logger?: Logger;
  metrics?: Metrics;
  /**
   * Deployment environment of the composition that loads the engine. When given and not local/ci, the
   * evaluator decoration seam is refused on this engine whatever its caller claims (OPS-04).
   */
  environment?: Environment;
}

/** Environments in which the evaluator decoration (fault-injection) seam may be installed (OPS-04). */
export const EVALUATOR_SEAM_ENVIRONMENTS: readonly Environment[] = ["local", "ci"];

export interface LoadBundleOptions extends EngineOptions {
  /** Directory holding bundle.tar.gz (policy/build), or the policy/ directory itself. */
  bundleDir?: string;
  /** Pinned values from reviewed configuration / ReleaseManifest; mismatch refuses to load. */
  expectedVersion?: string | null;
  expectedDigest?: string | null;
}

export interface EngineDescription {
  kind: "live";
  policyVersion: string;
  bundleDigest: string;
  entrypoints: string[];
  catalogueSchemaVersion: number;
  actions: string[];
  consoleActions: string[];
}

// ---------------------------------------------------------------------------
// Timestamp normalization: the Rego parses only YYYY-MM-DDTHH:MM:SS.sssZ.
// ---------------------------------------------------------------------------

/** Canonical millisecond UTC form, or null when the value is not a real instant. */
export function canonicalTimestamp(value: string): string | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const out = new Date(ms).toISOString();
  // Reject calendar rollovers (e.g. Feb 30 -> Mar 2) and anything outside 0000-9999.
  if (out.length !== 24 || out.slice(0, 19) !== value.slice(0, 19)) return null;
  return out;
}

function mustCanonical(value: string): string {
  const out = canonicalTimestamp(value);
  if (out === null) throw new PolicyInputNormalizationError();
  return out;
}

class PolicyInputNormalizationError extends Error {}

const canonicalOrNull = (v: string | null): string | null => (v === null ? null : mustCanonical(v));

export function normalizePolicyInput(input: PolicyInput): PolicyInput {
  return {
    ...input,
    now: mustCanonical(input.now),
    auth: {
      ...input.auth,
      authenticatedAt: canonicalOrNull(input.auth.authenticatedAt),
      expiresAt: mustCanonical(input.auth.expiresAt),
      stepUpExpiresAt: canonicalOrNull(input.auth.stepUpExpiresAt),
    },
    relationships: input.relationships.map((f) => ({ ...f, validUntil: canonicalOrNull(f.validUntil) })),
  };
}

export function normalizeConsoleInput(input: ConsoleDecisionInput): ConsoleDecisionInput {
  const bg = input.staff.breakGlass;
  return {
    ...input,
    now: mustCanonical(input.now),
    staff: {
      ...input.staff,
      authenticatedAt: mustCanonical(input.staff.authenticatedAt),
      breakGlass: bg === null ? null : { ...bg, grantedAt: mustCanonical(bg.grantedAt), expiresAt: mustCanonical(bg.expiresAt) },
    },
  };
}

/** A frozen copy of `v` (structured clone, every nested object and array frozen). */
function deepFrozenClone<T>(v: T): T {
  const freeze = (x: unknown): void => {
    if (typeof x !== "object" || x === null || Object.isFrozen(x)) return;
    Object.freeze(x);
    for (const child of Object.values(x as Record<string, unknown>)) freeze(child);
  };
  const copy = structuredClone(v);
  freeze(copy);
  return copy;
}

/**
 * Frozen view of an evaluator: its entrypoints copied and frozen, `evaluate` bound to the original object as it
 * was at construction (a later reassignment of the original's `evaluate` is not picked up).
 */
function frozenEvaluatorView(e: PolicyEvaluator): PolicyEvaluator {
  const evaluate = e.evaluate;
  return Object.freeze({ entrypoints: Object.freeze([...e.entrypoints]), evaluate: (input: unknown, entrypoint: string): unknown => evaluate.call(e, input, entrypoint) });
}

/**
 * Hard invariants checked in TypeScript after the WASM decision. They can only
 * turn an allow into a deny (defence in depth for AUTH-04, AUTH-06, SAFE-02
 * scope of exemptions, OPS-06 kill switches). Returns null when satisfied.
 */
export function invariantViolation(input: PolicyInput, decision: RegoAuthzDecision, catalogue: PolicyCatalogue): string | null {
  if (!decision.allow) return null;
  const def = catalogue.actions[input.action];
  if (!def) return "ALLOW_FOR_UNCATALOGUED_ACTION";
  if (decision.fieldMask.some((f) => !def.fieldMask.includes(f))) return "FIELD_MASK_EXCEEDS_CATALOGUE";
  if (isAlwaysAvailableAction(input.action)) return null;
  const nowMs = Date.parse(input.now);
  if (input.auth.revoked || !(Date.parse(input.auth.expiresAt) > nowMs)) return "ALLOW_WITH_INVALID_SESSION";
  if (input.auth.tenantId !== input.resource.tenantId) return "ALLOW_WITH_TENANT_MISMATCH";
  if (input.killSwitches.aiAdmission) return "ALLOW_WITH_AI_ADMISSION_KILLED";
  if (input.killSwitches.writes && def.killSwitchClass === "WRITE") return "ALLOW_WITH_WRITES_KILLED";
  if (input.resource.classification === "VERIFICATION_SECRET") return "ALLOW_FOR_VERIFICATION_SECRET";
  return null;
}

function boundReasons(codes: readonly string[]): string[] {
  const unique = [...new Set(codes)].sort();
  return unique.length <= MAX_REASON_CODES ? unique : [...unique.slice(0, MAX_REASON_CODES - 1), "REASON_CODES_TRUNCATED"];
}

function resultValue(resultSet: unknown): unknown {
  if (!Array.isArray(resultSet) || resultSet.length !== 1) return undefined;
  const first: unknown = resultSet[0];
  if (typeof first !== "object" || first === null || !("result" in first)) return undefined;
  return (first as { result: unknown }).result;
}

function readBounded(path: string, reason: string): Buffer {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_BUNDLE_BYTES) throw new PolicyBundleLoadError(reason);
    return readFileSync(path);
  } catch (e) {
    if (e instanceof PolicyBundleLoadError) throw e;
    throw new PolicyBundleLoadError(reason);
  }
}

/** Accepts policy/build or policy/ (whose build/ subdirectory holds the bundle). */
export function resolveBundleDir(dir: string): string {
  const abs = resolve(dir);
  if (existsSync(join(abs, "bundle.tar.gz"))) return abs;
  if (existsSync(join(abs, "build", "bundle.tar.gz"))) return join(abs, "build");
  throw new PolicyBundleLoadError("POLICY_BUNDLE_NOT_FOUND");
}

interface EngineParts {
  policyVersion: string;
  bundleDigest: string;
  catalogue: PolicyCatalogue;
  evaluator: PolicyEvaluator;
}

export class OpaWasmPolicyEngine implements PolicyEngine {
  readonly kind = "live" as const;
  readonly policyVersion: string;
  readonly bundleDigest: string;
  readonly catalogue: PolicyCatalogue;
  /** The evaluator decisions use: the loaded one, or a decoration of it while one is installed. */
  private evaluator: PolicyEvaluator;
  /**
   * The evaluator the engine was built with, as a frozen view captured at construction, in an ECMAScript private
   * field: neither a decoration (it receives this frozen view as `inner`) nor a cast-based field swap can replace
   * or alter what the tighten-only rule consults.
   */
  readonly #loaded: PolicyEvaluator;
  private decoration: { handle: EvaluatorDecoration } | null = null;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly metrics: Metrics | undefined;
  private readonly environment: Environment | undefined;

  private constructor(parts: EngineParts, opts: EngineOptions) {
    this.policyVersion = parts.policyVersion;
    this.bundleDigest = parts.bundleDigest;
    this.catalogue = parts.catalogue;
    this.#loaded = frozenEvaluatorView(parts.evaluator);
    this.evaluator = this.#loaded;
    this.clock = opts.clock ?? systemClock;
    this.logger = (opts.logger ?? silentLogger).child({ component: "policy_engine" });
    this.metrics = opts.metrics;
    this.environment = opts.environment;
  }

  /**
   * Loads and verifies a built bundle. Throws PolicyBundleLoadError (reason code
   * only) when the bundle is missing, inconsistent, unpinned-value mismatched,
   * structurally unsafe or not loadable as WebAssembly. Callers that must stay
   * up can fall back to FailClosedPolicyEngine.
   */
  static async load(opts: LoadBundleOptions = {}): Promise<OpaWasmPolicyEngine> {
    const dir = resolveBundleDir(opts.bundleDir ?? DEFAULT_BUNDLE_DIR);
    const compressed = readBounded(join(dir, "bundle.tar.gz"), "POLICY_BUNDLE_UNREADABLE");
    const bundleDigest = sha256Hex(compressed);
    const recordedPath = join(dir, "bundle.sha256");
    if (existsSync(recordedPath)) {
      const recorded = readBounded(recordedPath, "POLICY_BUNDLE_UNREADABLE").toString("utf8").trim().split(/\s+/)[0];
      if (recorded !== bundleDigest) throw new PolicyBundleLoadError("POLICY_BUNDLE_DIGEST_MISMATCH");
    }
    if (opts.expectedDigest && opts.expectedDigest !== bundleDigest) throw new PolicyBundleLoadError("POLICY_BUNDLE_DIGEST_MISMATCH");

    let files: Map<string, Buffer>;
    try {
      files = readTarGz(compressed);
    } catch (e) {
      throw new PolicyBundleLoadError(e instanceof BundleArchiveError ? e.reasonCode : "POLICY_BUNDLE_UNREADABLE");
    }
    const wasm = files.get("policy.wasm");
    const dataBuf = files.get("data.json");
    const manifestBuf = files.get(".manifest");
    if (!wasm || !dataBuf || !manifestBuf) throw new PolicyBundleLoadError("POLICY_BUNDLE_INCOMPLETE");
    // Extracted copies are for inspection only; if present they must match the archive.
    for (const [name, buf] of [["policy.wasm", wasm], ["data.json", dataBuf], [".manifest", manifestBuf]] as const) {
      const p = join(dir, name);
      if (existsSync(p) && !readBounded(p, "POLICY_BUNDLE_UNREADABLE").equals(buf)) throw new PolicyBundleLoadError("POLICY_BUNDLE_EXTRACT_MISMATCH");
    }

    const manifest = parseJson(manifestBuf, BundleManifest, "POLICY_BUNDLE_MANIFEST_INVALID");
    const entrypoints = manifest.wasm.map((w) => w.entrypoint);
    if (!entrypoints.includes(AUTHZ_ENTRYPOINT) || !entrypoints.includes(CONSOLE_ENTRYPOINT)) throw new PolicyBundleLoadError("POLICY_BUNDLE_ENTRYPOINT_MISSING");
    if (opts.expectedVersion && opts.expectedVersion !== manifest.revision) throw new PolicyBundleLoadError("POLICY_VERSION_MISMATCH");
    const data = parseJson(dataBuf, PolicyBundleData, "POLICY_BUNDLE_CATALOGUE_INVALID");

    let evaluator: PolicyEvaluator;
    try {
      const policy = await loadPolicy(new Uint8Array(wasm), { ...WASM_MEMORY });
      policy.setData(data);
      const eps = Object.keys((policy.entrypoints ?? {}) as Record<string, number>);
      evaluator = { entrypoints: eps, evaluate: (input, entrypoint) => policy.evaluate(input, entrypoint) };
    } catch {
      throw new PolicyBundleLoadError("POLICY_BUNDLE_WASM_INVALID");
    }
    if (!evaluator.entrypoints.includes(AUTHZ_ENTRYPOINT) || !evaluator.entrypoints.includes(CONSOLE_ENTRYPOINT)) {
      throw new PolicyBundleLoadError("POLICY_BUNDLE_ENTRYPOINT_MISSING");
    }
    const engine = new OpaWasmPolicyEngine({ policyVersion: manifest.revision, bundleDigest, catalogue: data.vsp.catalogue, evaluator }, opts);
    engine.logger.info("policy.bundle.loaded", { version: manifest.revision, bundleDigest, reasonCode: "POLICY_BUNDLE_LOADED" });
    return engine;
  }

  /**
   * TEST SEAM: an engine over an arbitrary evaluator (fault injection). The
   * catalogue is still strictly validated.
   */
  static fromEvaluator(parts: { policyVersion: string; bundleDigest: string; catalogue: unknown; evaluator: PolicyEvaluator }, opts: EngineOptions = {}): OpaWasmPolicyEngine {
    const catalogue = PolicyBundleData.parse({ vsp: { catalogue: parts.catalogue } }).vsp.catalogue;
    return new OpaWasmPolicyEngine({ policyVersion: VersionLabel.parse(parts.policyVersion), bundleDigest: parts.bundleDigest, catalogue, evaluator: parts.evaluator }, opts);
  }

  /**
   * Same loaded bundle and evaluator with different observability or clock (e.g. a child logger per
   * request scope). The copy is built over the undecorated evaluator: a fault decoration installed with
   * `decorateEvaluator` belongs to the engine instance it was installed on.
   */
  withOptions(opts: EngineOptions): OpaWasmPolicyEngine {
    return new OpaWasmPolicyEngine(
      { policyVersion: this.policyVersion, bundleDigest: this.bundleDigest, catalogue: this.catalogue, evaluator: this.#loaded },
      { clock: opts.clock ?? this.clock, logger: opts.logger ?? this.logger, metrics: opts.metrics ?? this.metrics, environment: opts.environment ?? this.environment },
    );
  }

  /**
   * FAULT-INJECTION SEAM (FO-17-24.POLICY_ENGINE_ERROR; scenarios/fixtures/failures/POLICY_ENGINE_ERROR.json).
   * Local and CI only (OPS-04): refused (POLICY_EVALUATOR_SEAM_NOT_ALLOWED) unless `opts.environment` is local
   * or ci AND the engine itself was not loaded for a deployed environment (EngineOptions.environment).
   *
   * Replaces the evaluation step (the WASM `policy.evaluate` call) of THIS engine instance with
   * `decorate(inner)`, where `inner` is the evaluator the engine was loaded with. Everything around the
   * evaluation stays the production engine: strict input parsing and normalisation, result validation,
   * the invariant guard, and the fail-closed path that turns a throw or an unusable result into a deny
   * with POLICY_ENGINE_ERROR.
   *
   * TIGHTEN-ONLY, enforced (not assumed): whenever the evaluator in use is not the loaded one, a decorated
   * ALLOW is accepted only if the loaded evaluator, asked the same question, also allows, the decorated field
   * mask is a subset of the loaded one and every loaded obligation is kept; the reason codes are the loaded
   * ones. Anything else is a deny with POLICY_ENGINE_ERROR (detail POLICY_EVALUATOR_DECORATION_WIDENED). A
   * decorated deny, throw or malformed result can only deny. So a decoration can make decisions fail closed,
   * narrow them or pass them through; it can never allow what the loaded policy denies.
   *
   * INPUT ISOLATION: the "same question" is the engine's own normalised input, which a substituted evaluator
   * never sees. It receives a deep-frozen structured clone (an in-place rewrite of, say, `auth.assurance`
   * throws; a rewritten copy only changes what the decoration itself asks), while the loaded evaluator and the
   * invariant guard read the pristine original. `inner` is a frozen view of the loaded evaluator, captured at
   * construction in a private field, so a decoration cannot replace what the rule consults either.
   *
   * Rules: one decoration at a time (POLICY_EVALUATOR_ALREADY_DECORATED); the decorated evaluator must
   * expose exactly the inner entrypoints (POLICY_EVALUATOR_DECORATION_INVALID). `remove()` restores the
   * loaded evaluator. A freshly loaded engine has no decoration (`evaluatorDecorated` is false), and the
   * production composition never calls this method: only evaluation fault plans do
   * (platform/src/evaluation/policy-fault.ts).
   */
  decorateEvaluator(decorate: (inner: PolicyEvaluator) => PolicyEvaluator, opts: { environment: Environment }): EvaluatorDecoration {
    const claimed = opts?.environment;
    if (!EVALUATOR_SEAM_ENVIRONMENTS.includes(claimed) || (this.environment !== undefined && !EVALUATOR_SEAM_ENVIRONMENTS.includes(this.environment))) {
      this.logger.warn("policy.evaluator.decoration_refused", { reasonCode: "POLICY_EVALUATOR_SEAM_NOT_ALLOWED" });
      throw new PolicyEvaluatorSeamError("POLICY_EVALUATOR_SEAM_NOT_ALLOWED");
    }
    if (this.decoration) throw new PolicyEvaluatorSeamError("POLICY_EVALUATOR_ALREADY_DECORATED");
    const inner = this.#loaded;
    const decorated = decorate(inner);
    const sameEntrypoints =
      typeof decorated === "object" &&
      decorated !== null &&
      typeof decorated.evaluate === "function" &&
      Array.isArray(decorated.entrypoints) &&
      decorated.entrypoints.length === inner.entrypoints.length &&
      inner.entrypoints.every((e) => decorated.entrypoints.includes(e));
    if (!sameEntrypoints) throw new PolicyEvaluatorSeamError("POLICY_EVALUATOR_DECORATION_INVALID");
    const state = { active: true };
    const handle: EvaluatorDecoration = {
      get active() {
        return state.active;
      },
      remove: () => {
        if (!state.active) return;
        state.active = false;
        if (this.decoration?.handle === handle) {
          this.evaluator = this.#loaded;
          this.decoration = null;
        }
      },
    };
    this.evaluator = decorated;
    this.decoration = { handle };
    this.logger.warn("policy.evaluator.decorated", { reasonCode: "POLICY_EVALUATOR_DECORATED" });
    return handle;
  }

  /** True while a fault decoration is installed on this engine instance (never in production composition). */
  get evaluatorDecorated(): boolean {
    return this.decoration !== null;
  }

  describe(): EngineDescription {
    return {
      kind: this.kind,
      policyVersion: this.policyVersion,
      bundleDigest: this.bundleDigest,
      entrypoints: [...this.evaluator.entrypoints].sort(),
      catalogueSchemaVersion: this.catalogue.schemaVersion,
      actions: Object.keys(this.catalogue.actions).sort(),
      consoleActions: Object.keys(this.catalogue.console.actions).sort(),
    };
  }

  async decide(input: PolicyInput): Promise<PolicyDecision> {
    return this.decideSync(input);
  }

  /** Synchronous variant (the WASM evaluation itself is synchronous). Never throws. */
  decideSync(rawInput: unknown): PolicyDecision {
    let action = "unknown";
    try {
      const parsed = PolicyInput.safeParse(rawInput);
      if (!parsed.success) return this.authzDeny("POLICY_INPUT_INVALID", action);
      action = parsed.data.action;
      let input: PolicyInput;
      try {
        input = normalizePolicyInput(parsed.data);
      } catch {
        return this.authzDeny("POLICY_INPUT_INVALID", action);
      }
      if (JSON.stringify(input).length > MAX_POLICY_INPUT_BYTES) return this.authzDeny("POLICY_INPUT_INVALID", action);

      const evaluated = RegoAuthzDecision.safeParse(resultValue(this.evaluateInUse(input, AUTHZ_ENTRYPOINT)));
      if (!evaluated.success) return this.authzDeny("POLICY_ENGINE_ERROR", action, "POLICY_RESULT_MALFORMED");
      const raw = this.tightenedAuthz(input, evaluated.data);
      if (raw === null) return this.authzDeny("POLICY_ENGINE_ERROR", action, "POLICY_EVALUATOR_DECORATION_WIDENED");
      const violation = invariantViolation(input, raw.data, this.catalogue);
      if (violation) return this.authzDeny("POLICY_ENGINE_ERROR", action, violation);

      const decision = PolicyDecision.parse({
        decisionId: newId("pdc"),
        allow: raw.data.allow,
        reasonCodes: boundReasons(raw.data.reasonCodes),
        fieldMask: raw.data.allow ? [...raw.data.fieldMask].sort() : [],
        obligations: [...new Set(raw.data.obligations)].sort(),
        policyVersion: this.policyVersion,
        // A broken clock throws here and fails closed in the catch below.
        evaluatedAt: this.clock.now().toISOString(),
      });
      this.record(decision, action, input.tool?.consequential ?? false);
      return decision;
    } catch {
      return this.authzDeny("POLICY_ENGINE_ERROR", action, "POLICY_EVALUATION_FAILED");
    }
  }

  async decideConsole(input: ConsoleDecisionInput): Promise<ConsoleDecision> {
    return this.decideConsoleSync(input);
  }

  decideConsoleSync(rawInput: unknown): ConsoleDecision {
    let action = "unknown";
    try {
      const parsed = ConsoleDecisionInput.safeParse(rawInput);
      if (!parsed.success) return this.consoleDeny("POLICY_INPUT_INVALID", action);
      action = parsed.data.action;
      let input: ConsoleDecisionInput;
      try {
        input = normalizeConsoleInput(parsed.data);
      } catch {
        return this.consoleDeny("POLICY_INPUT_INVALID", action);
      }
      const evaluated = RegoConsoleDecision.safeParse(resultValue(this.evaluateInUse(input, CONSOLE_ENTRYPOINT)));
      if (!evaluated.success) return this.consoleDeny("POLICY_ENGINE_ERROR", action, "POLICY_RESULT_MALFORMED");
      const raw = this.tightenedConsole(input, evaluated.data);
      if (raw === null) return this.consoleDeny("POLICY_ENGINE_ERROR", action, "POLICY_EVALUATOR_DECORATION_WIDENED");
      // Guard: MFA and origin are hard requirements regardless of the WASM result.
      if (raw.data.allow && (!input.staff.mfa || input.origin !== "workforce_console")) return this.consoleDeny("POLICY_ENGINE_ERROR", action, "CONSOLE_INVARIANT_VIOLATION");
      const decision = ConsoleDecision.parse({
        decisionId: newId("pdc"),
        allow: raw.data.allow,
        reasonCodes: boundReasons(raw.data.reasonCodes),
        obligations: [...new Set([...raw.data.obligations, "AUDIT_ADMIN_ACTION" as const])].sort(),
        policyVersion: this.policyVersion,
        evaluatedAt: this.clock.now().toISOString(),
      });
      this.logger.debug("policy.console.decision", { action: safeAction(action), allow: decision.allow, reasonCode: decision.reasonCodes[0] ?? null, decisionId: decision.decisionId });
      return decision;
    } catch {
      return this.consoleDeny("POLICY_ENGINE_ERROR", action, "POLICY_EVALUATION_FAILED");
    }
  }

  /**
   * Evaluation step. The loaded evaluator reads the engine's input directly; a substituted one (a decoration, or
   * anything swapped into the field) gets a deep-frozen structured clone, so it can never change the pristine
   * input that the tighten-only rule and the invariant guard evaluate afterwards.
   */
  private evaluateInUse(input: PolicyInput | ConsoleDecisionInput, entrypoint: string): unknown {
    if (this.evaluator === this.#loaded) return this.#loaded.evaluate(input, entrypoint);
    return this.evaluator.evaluate(deepFrozenClone(input), entrypoint);
  }

  /**
   * Tighten-only rule for a substituted evaluator (see decorateEvaluator). Returns the decision to use, or null
   * when a decorated allow is wider than what the loaded evaluator decides for the same input. The loaded
   * evaluator is consulted only when the evaluator in use is not the loaded one and it allowed.
   */
  private tightenedAuthz(input: PolicyInput, decided: RegoAuthzDecision): { data: RegoAuthzDecision } | null {
    if (this.evaluator === this.#loaded || !decided.allow) return { data: decided };
    const loaded = RegoAuthzDecision.safeParse(resultValue(this.#loaded.evaluate(input, AUTHZ_ENTRYPOINT)));
    if (!loaded.success || !loaded.data.allow) return null;
    if (decided.fieldMask.some((f) => !loaded.data.fieldMask.includes(f))) return null;
    if (loaded.data.obligations.some((o) => !decided.obligations.includes(o))) return null;
    return { data: { allow: true, reasonCodes: loaded.data.reasonCodes, fieldMask: decided.fieldMask, obligations: decided.obligations } };
  }

  private tightenedConsole(input: ConsoleDecisionInput, decided: z.infer<typeof RegoConsoleDecision>): { data: z.infer<typeof RegoConsoleDecision> } | null {
    if (this.evaluator === this.#loaded || !decided.allow) return { data: decided };
    const loaded = RegoConsoleDecision.safeParse(resultValue(this.#loaded.evaluate(input, CONSOLE_ENTRYPOINT)));
    if (!loaded.success || !loaded.data.allow) return null;
    if (loaded.data.obligations.some((o) => !decided.obligations.includes(o))) return null;
    return { data: { allow: true, reasonCodes: loaded.data.reasonCodes, obligations: decided.obligations } };
  }

  private nowIso(): string {
    try {
      return this.clock.now().toISOString();
    } catch {
      return "1970-01-01T00:00:00.000Z";
    }
  }

  private record(decision: PolicyDecision, action: string, consequential: boolean): void {
    try {
      this.logger.debug("policy.decision", {
        action: safeAction(action),
        allow: decision.allow,
        reasonCode: decision.reasonCodes[0] ?? null,
        decisionId: decision.decisionId,
        version: decision.policyVersion,
      });
      this.metrics?.increment("vsp_policy_decisions_total", { allow: String(decision.allow), consequential: String(consequential) });
    } catch {
      // Observability must never change or block a decision.
    }
  }

  private authzDeny(reason: "POLICY_INPUT_INVALID" | "POLICY_ENGINE_ERROR", action: string, detail?: string): PolicyDecision {
    const decision: PolicyDecision = {
      decisionId: safeDecisionId(),
      allow: false,
      reasonCodes: [reason],
      fieldMask: [],
      obligations: [],
      policyVersion: this.policyVersion,
      evaluatedAt: this.nowIso(),
    };
    try {
      this.logger.warn("policy.decision.fail_closed", { action: safeAction(action), reasonCode: reason, detailCode: detail ?? reason });
      this.metrics?.increment("vsp_policy_decisions_total", { allow: "false", consequential: "false" });
    } catch {
      // ignore
    }
    return decision;
  }

  private consoleDeny(reason: "POLICY_INPUT_INVALID" | "POLICY_ENGINE_ERROR", action: string, detail?: string): ConsoleDecision {
    try {
      this.logger.warn("policy.console.fail_closed", { action: safeAction(action), reasonCode: reason, detailCode: detail ?? reason });
    } catch {
      // ignore
    }
    return {
      decisionId: safeDecisionId(),
      allow: false,
      reasonCodes: [reason],
      obligations: ["AUDIT_ADMIN_ACTION"],
      policyVersion: this.policyVersion,
      evaluatedAt: this.nowIso(),
    };
  }
}

/**
 * Engine used when no bundle could be loaded: every decision is a deny with
 * POLICY_ENGINE_ERROR. Safety and human routes must not depend on a policy
 * decision succeeding (independent Studio route, spec section 3; SAFE-02).
 */
export class FailClosedPolicyEngine implements PolicyEngine {
  readonly kind = "live" as const;
  readonly policyVersion = "unavailable";
  readonly bundleDigest = "0".repeat(64);
  constructor(
    readonly loadReasonCode: string = "POLICY_BUNDLE_NOT_FOUND",
    private readonly clock: Clock = systemClock,
  ) {}

  async decide(_input: PolicyInput): Promise<PolicyDecision> {
    return { decisionId: safeDecisionId(), allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"], fieldMask: [], obligations: [], policyVersion: this.policyVersion, evaluatedAt: safeIso(this.clock) };
  }

  async decideConsole(_input: ConsoleDecisionInput): Promise<ConsoleDecision> {
    return { decisionId: safeDecisionId(), allow: false, reasonCodes: ["POLICY_ENGINE_ERROR"], obligations: ["AUDIT_ADMIN_ACTION"], policyVersion: this.policyVersion, evaluatedAt: safeIso(this.clock) };
  }
}

/** Loads the bundle, or returns a FailClosedPolicyEngine carrying the load reason code. */
export async function loadPolicyEngineOrFailClosed(opts: LoadBundleOptions = {}): Promise<OpaWasmPolicyEngine | FailClosedPolicyEngine> {
  try {
    return await OpaWasmPolicyEngine.load(opts);
  } catch (e) {
    const reason = e instanceof PlatformError ? e.reasonCode : "POLICY_BUNDLE_UNREADABLE";
    (opts.logger ?? silentLogger).error("policy.bundle.load_failed", { reasonCode: reason });
    return new FailClosedPolicyEngine(reason, opts.clock);
  }
}

function parseJson<T>(buf: Buffer, schema: z.ZodType<T>, reason: string): T {
  let value: unknown;
  try {
    value = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new PolicyBundleLoadError(reason);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PolicyBundleLoadError(reason);
  return parsed.data;
}

function safeAction(action: string): string {
  return /^[a-z_]+:[a-z_]+$/.test(action) ? action : "invalid";
}

function safeDecisionId(): string {
  try {
    return newId("pdc");
  } catch {
    return "pdc_unavailable00000000";
  }
}

function safeIso(clock: Clock): string {
  try {
    return clock.now().toISOString();
  } catch {
    return "1970-01-01T00:00:00.000Z";
  }
}
