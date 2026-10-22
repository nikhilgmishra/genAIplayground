/**
 * Startup egress check (spec section 6 "Map every PHI processor, storage location, support-access
 * path, backup, telemetry sink, and deletion path"; DATA-01, OPS-04).
 *
 * Before anything is constructed, the composition root lists every OUTBOUND destination the
 * process is configured to use and checks each one against the egress allowlist (EgressGuard):
 *  - every adapter in `PlatformConfig.adapters` (live adapters must declare their documented
 *    endpoint; business systems receive PHI, so their destination must be PHI-capable with a
 *    BAA/coverage reference and an approval id; identity providers receive content-free requests);
 *  - the inbound-auth JWKS URI (`gateway.inboundAuth.jwksUri`, content-free);
 *  - the audit sink (`audit.sink`; the S3 Object Lock sink has no endpoint in PlatformConfig yet);
 *  - every telemetry / export destination the entry point composes (OpenTelemetry or analytics
 *    exporters, evaluation export sinks): content-free classes only, and the destination must be
 *    a telemetry exporter or analytics sink;
 *  - every model endpoint the entry point composes (WP-08 `modelEgressTargets`): the destination must be
 *    a model class (MODEL_PROVIDER_API or MODEL_SELF_HOSTED) approved for the endpoint's data class and
 *    for exactly its provider, region and retention terms (EgressGuard.checkModelEndpoint).
 * In-process LOCAL FIXTURE components have no network egress and are reported as such (the
 * configuration guard, not this check, refuses fixtures outside local/ci).
 *
 * Fail closed: any violation refuses startup (ConfigurationRejectedError with `<REASON>@<path>`
 * codes). Outside local/ci a missing egress policy is itself a violation
 * (`EGRESS_POLICY_NOT_CONFIGURED@egress`) and every live target is denied; in local/ci the default
 * policy is LOCAL_FIXTURE_EGRESS_POLICY, which approves NO destination (the local composition has
 * no network egress), so a live endpoint configured locally is refused too.
 */
import type { PlatformConfig } from "../config/ports.js";
import type { Classification, Environment } from "../protocol/index.js";
import { ConfigurationRejectedError } from "../shared/errors.js";
import { EgressGuard } from "./egress.js";
import type { EgressDestination, EgressPolicyConfig, ModelEgressBinding } from "./egress.js";

/**
 * LOCAL FIXTURE egress policy: no destination is approved (no BAA, coverage reference or approval
 * exists, and the offline composition wires in-process fixtures only). Anything that would leave
 * the process is therefore denied, including the restricted quarantine store (redaction failures
 * stay in their original restricted location).
 */
export const LOCAL_FIXTURE_EGRESS_POLICY: EgressPolicyConfig = Object.freeze({ policyVersion: "local-fixture-no-egress.1", destinations: [] }) as EgressPolicyConfig;

export type EgressTargetKind = "adapter" | "inbound_auth_jwks" | "audit_sink" | "telemetry_export" | "model_endpoint";

export interface EgressStartupTarget {
  /** Configuration path the target comes from (used in reason codes), e.g. `adapters.salesforce.endpoint`. */
  ref: string;
  kind: EgressTargetKind;
  adapterKind: "local_fixture" | "live";
  url: string | null;
  /** Most sensitive class the destination receives. */
  dataClass: Classification;
  /** model_endpoint targets only: the provider, region and retention terms the model adapter is bound to. */
  modelBinding?: ModelEgressBinding;
}

/** A model endpoint an entry point composes (platform/src/models/adapters, WP-08 `modelEgressTargets`). */
export interface ModelEndpointTarget {
  /** Short code-like name, e.g. `planner_primary`. */
  ref: string;
  url: string;
  /** Most sensitive class the endpoint receives (PHI for a role that sees masked case context). */
  dataClass: Classification;
  binding: ModelEgressBinding;
}

/** A telemetry / export destination an entry point composes (none in the local composition). */
export interface TelemetryExportTarget {
  /** Short code-like name, e.g. `otel_metrics`. */
  ref: string;
  url: string;
}

export type EgressTargetStatus = "ALLOWED" | "IN_PROCESS_FIXTURE" | "DENIED";

export interface EgressStartupReport {
  environment: Environment;
  policyVersion: string | null;
  targets: { ref: string; kind: EgressTargetKind; status: EgressTargetStatus; reasonCode: string; destinationId: string | null }[];
  /** `<REASON>@<path>` codes; empty = every configured destination is approved. */
  violations: string[];
}

/**
 * Adapters whose live endpoints receive only content-free requests (OIDC discovery / JWKS). Every
 * other adapter, including unknown keys, is treated as receiving PHI (strictest; fail closed).
 */
const CONTENT_FREE_ADAPTERS: ReadonlySet<string> = new Set(["oidc-client-idp", "oidc-provider-idp", "workforce-sso"]);
const TELEMETRY_KINDS: ReadonlySet<EgressDestination["kind"]> = new Set(["TELEMETRY_EXPORTER", "ANALYTICS_SINK"]);
const REF = /^[a-z][a-z0-9_]{1,40}$/;
const OFFLINE: readonly Environment[] = ["local", "ci"];

/** Every outbound destination named by the configuration plus the composed telemetry exports and model endpoints. */
export function egressTargetsFor(config: PlatformConfig, telemetry: readonly TelemetryExportTarget[] = [], models: readonly ModelEndpointTarget[] = []): EgressStartupTarget[] {
  const out: EgressStartupTarget[] = [];
  for (const key of Object.keys(config.adapters).sort()) {
    const a = config.adapters[key];
    if (!a) continue;
    out.push({ ref: `adapters.${key}.endpoint`, kind: "adapter", adapterKind: a.kind, url: a.endpoint, dataClass: CONTENT_FREE_ADAPTERS.has(key) ? "INTERNAL" : "PHI" });
  }
  const jwks = config.gateway?.inboundAuth?.jwksUri ?? null;
  if (jwks !== null) out.push({ ref: "gateway.inboundAuth.jwksUri", kind: "inbound_auth_jwks", adapterKind: "live", url: jwks, dataClass: "INTERNAL" });
  out.push({ ref: "audit.sink", kind: "audit_sink", adapterKind: config.audit.sink === "local_fixture" ? "local_fixture" : "live", url: null, dataClass: "INTERNAL" });
  for (const t of telemetry) {
    if (!REF.test(t.ref)) throw new ConfigurationRejectedError(["EGRESS_TELEMETRY_REF_INVALID@telemetry"]);
    out.push({ ref: `telemetry.${t.ref}`, kind: "telemetry_export", adapterKind: "live", url: t.url, dataClass: "INTERNAL" });
  }
  for (const m of models) {
    if (!REF.test(m.ref)) throw new ConfigurationRejectedError(["EGRESS_MODEL_REF_INVALID@models"]);
    out.push({ ref: `models.${m.ref}`, kind: "model_endpoint", adapterKind: "live", url: m.url, dataClass: m.dataClass, modelBinding: m.binding });
  }
  return out;
}

/**
 * Checks every target. Never throws for a denied target (the report lists it); throws
 * ConfigurationRejectedError only when the policy itself violates a hard rule (EgressGuard).
 */
export function checkStartupEgress(input: { environment: Environment; policy: EgressPolicyConfig | null; targets: readonly EgressStartupTarget[] }): EgressStartupReport {
  const offline = OFFLINE.includes(input.environment);
  const violations: string[] = [];
  if (!input.policy && !offline) violations.push("EGRESS_POLICY_NOT_CONFIGURED@egress");
  const policy = input.policy ?? (offline ? LOCAL_FIXTURE_EGRESS_POLICY : { policyVersion: "none", destinations: [] });
  const guard = new EgressGuard(policy, { environment: input.environment });
  const targets: EgressStartupReport["targets"] = [];
  for (const t of input.targets) {
    if (t.adapterKind === "local_fixture") {
      targets.push({ ref: t.ref, kind: t.kind, status: "IN_PROCESS_FIXTURE", reasonCode: "EGRESS_NONE_IN_PROCESS_FIXTURE", destinationId: null });
      continue;
    }
    const deny = (reasonCode: string, destinationId: string | null = null) => {
      targets.push({ ref: t.ref, kind: t.kind, status: "DENIED", reasonCode, destinationId });
      violations.push(`${reasonCode}@${t.ref}`);
    };
    if (t.url === null) {
      deny("EGRESS_ENDPOINT_UNDECLARED");
      continue;
    }
    if (t.kind === "model_endpoint" && t.modelBinding === undefined) {
      deny("EGRESS_MODEL_BINDING_MISSING");
      continue;
    }
    const decision = t.kind === "model_endpoint" && t.modelBinding !== undefined ? guard.checkModelEndpoint(t.url, t.dataClass, t.modelBinding) : guard.check(t.url, t.dataClass);
    if (!decision.allowed) {
      deny(decision.reasonCode, decision.destinationId);
      continue;
    }
    const d = guard.list().find((x) => x.destinationId === decision.destinationId);
    if (t.kind === "telemetry_export" && (!d || !TELEMETRY_KINDS.has(d.kind))) {
      deny("EGRESS_NOT_A_TELEMETRY_DESTINATION", decision.destinationId);
      continue;
    }
    if (t.kind === "audit_sink" && d?.kind !== "AUDIT_SINK") {
      deny("EGRESS_NOT_AN_AUDIT_SINK", decision.destinationId);
      continue;
    }
    targets.push({ ref: t.ref, kind: t.kind, status: "ALLOWED", reasonCode: "EGRESS_ALLOWED", destinationId: decision.destinationId });
  }
  return { environment: input.environment, policyVersion: input.policy ? policy.policyVersion : offline ? policy.policyVersion : null, targets, violations };
}

/** Fail closed: refuses startup when any configured destination is not approved. */
export function assertStartupEgress(report: EgressStartupReport): void {
  if (report.violations.length > 0) throw new ConfigurationRejectedError([...report.violations]);
}
