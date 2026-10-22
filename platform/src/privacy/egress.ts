/**
 * Egress allowlist (spec sections 6 and 13, DATA-01).
 *
 * Every outbound payload is checked against an allowlist of approved
 * destinations per payload classification. The guard fails closed:
 *  - unknown destinations are denied for every class (allowlist only);
 *  - PHI / PHI_RESTRICTED / FINANCIAL may only go to PHI-capable destination
 *    kinds that carry both a BAA/coverage reference and an approval id;
 *  - VERIFICATION_SECRET may only go to a verification service (AUTH-06);
 *  - telemetry exporters, analytics sinks, developer tools, debugging vendors,
 *    support ticketing, audit sinks and public web destinations accept
 *    content-free classes (PUBLIC, INTERNAL) only — config cannot override this;
 *  - URLs must be https (loopback http only in local/ci), carry no userinfo,
 *    match a configured host exactly and contain no PHI-like pattern in the
 *    path or query (no PHI in URLs); only platform ids and a destination's reviewed
 *    `opaquePathIds` constants are exempt from that scan;
 *  - in production, destinations labelled local_fixture are rejected (OPS-04);
 *  - model endpoints have their own destination classes (WP-08, FO-09-45, FO-19-09): MODEL_PROVIDER_API
 *    (publisher or cloud-hosted inference API) and MODEL_SELF_HOSTED (self-hosted inference in approved
 *    infrastructure). Each carries the provider, region and retention terms it was approved under, and a
 *    model adapter's per-request check (`forModelEndpoint`) refuses a destination whose terms differ from
 *    the adapter's binding, so an unavailable model never silently falls back to an unapproved provider,
 *    region or retention policy (prompt section 9).
 *
 * Configuration that violates a hard rule is rejected at construction, not
 * silently narrowed. The coverage/approval references are not verified here
 * against signed approval records; the composition root must bind them to the
 * config module's approval loader (see README, BLOCKED).
 */
import { z } from "zod";
import { Classification, Environment } from "../protocol/index.js";
import type { Logger, Metrics } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { AccessDeniedError, ConfigurationRejectedError } from "../shared/errors.js";
import { CONTENT_FREE_CLASSES, isPhiClass } from "./classification.js";
import { detectSensitiveSpans, luhnValid } from "./patterns.js";

export const DestinationKind = z.enum([
  "PHI_PROCESSOR",
  "SYSTEM_OF_RECORD",
  /** Generic model destination (connector profiles of the model_provider family); not usable by the model adapters. */
  "MODEL_ENDPOINT",
  /** Model class: a publisher or cloud-hosted inference API (OpenAI Responses, Amazon Bedrock). */
  "MODEL_PROVIDER_API",
  /** Model class: self-hosted inference (vLLM) in approved infrastructure. */
  "MODEL_SELF_HOSTED",
  "RESTRICTED_MEDIA_STORE",
  "VERIFICATION_SERVICE",
  "AUDIT_SINK",
  "TELEMETRY_EXPORTER",
  "ANALYTICS_SINK",
  "DEVELOPER_TOOL",
  "DEBUGGING_VENDOR",
  "SUPPORT_TICKETING",
  "PUBLIC_WEB",
]);
export type DestinationKind = z.infer<typeof DestinationKind>;

/** Destination kinds that may ever receive PHI / financial data (with coverage + approval). */
export const PHI_CAPABLE_KINDS: ReadonlySet<DestinationKind> = new Set(["PHI_PROCESSOR", "SYSTEM_OF_RECORD", "MODEL_ENDPOINT", "MODEL_PROVIDER_API", "MODEL_SELF_HOSTED", "RESTRICTED_MEDIA_STORE"]);
/** The model endpoint classes: destinations a model adapter may reach, each bound to its approved model terms. */
export const MODEL_CLASS_KINDS: ReadonlySet<DestinationKind> = new Set(["MODEL_PROVIDER_API", "MODEL_SELF_HOSTED"]);
/** Destination kinds limited to content-free classes regardless of configuration. */
export const CONTENT_FREE_ONLY_KINDS: ReadonlySet<DestinationKind> = new Set([
  "AUDIT_SINK",
  "TELEMETRY_EXPORTER",
  "ANALYTICS_SINK",
  "DEVELOPER_TOOL",
  "DEBUGGING_VENDOR",
  "SUPPORT_TICKETING",
  "PUBLIC_WEB",
]);

const HOST = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/, "lowercase host[:port]");

/** RFC 9562 layout (8-4-4-4-12 hex, version 1-8, variant 10xx), lower case: a reviewed opaque path identifier. */
export const CanonicalUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "lower-case canonical UUID");

/** Region of a model endpoint: an AWS-style region code, or `local` for a local/ci emulator or local weights. */
export const ModelEndpointRegion = z.string().regex(/^[a-z]{2}(-[a-z]+)+-[0-9]$|^local$/);

/**
 * The terms a model endpoint destination was approved under (AIN-26, AIN-49): the provider protocol, the region
 * and the data retention / logging terms. Required on the model classes and refused on every other kind.
 */
export const ModelEndpointTerms = z.strictObject({
  /** Provider protocol id as the model adapters name it (e.g. `openai_responses`). */
  provider: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  region: ModelEndpointRegion,
  /** Reference to the approved retention and logging terms of this endpoint (for example a zero-retention record). */
  retentionPolicyRef: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
});
export type ModelEndpointTerms = z.infer<typeof ModelEndpointTerms>;

export const EgressDestination = z.strictObject({
  destinationId: z.string().regex(/^egr_[a-z0-9_]{3,40}$/),
  kind: DestinationKind,
  /** Exact hosts (optionally host:port). No wildcards. */
  hosts: z.array(HOST).min(1).max(8),
  allowedClasses: z.array(Classification).min(1).max(6),
  /** BAA / contract coverage reference and approval id; both required for PHI-capable use. */
  coverage: z.strictObject({
    baaRef: z.string().min(3).max(200).nullable(),
    approvalId: z.string().regex(/^apr_[A-Za-z0-9_-]{8,64}$/).nullable(),
  }),
  environments: z.array(Environment).min(1).max(5),
  adapterKind: z.enum(["local_fixture", "live"]),
  /** Model classes only (MODEL_PROVIDER_API, MODEL_SELF_HOSTED): the approved model endpoint terms. */
  model: ModelEndpointTerms.optional(),
  /**
   * Reviewed opaque path identifiers of this destination (WP-08 decision on the wave B3 hand-off): exact canonical
   * UUIDs that may appear as a WHOLE path segment of a URL to this destination, for example the tenant id of a hosted
   * IdP issuer (`https://login.example/<tenant uuid>/v2.0`). A constant from reviewed configuration carries no
   * request data, so it is exempt from the URL scan; every other UUID-shaped segment is scanned like any other text.
   */
  opaquePathIds: z.array(CanonicalUuid).min(1).max(8).optional(),
});
export type EgressDestination = z.infer<typeof EgressDestination>;

export const EgressPolicyConfig = z.strictObject({
  policyVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
  destinations: z.array(EgressDestination).max(64),
});
export type EgressPolicyConfig = z.infer<typeof EgressPolicyConfig>;

export interface EgressDecision {
  allowed: boolean;
  reasonCode: string;
  destinationId: string | null;
}

export type EgressTarget = string | URL | { destinationId: string };

/** What a model adapter is bound to: the request may only reach a model-class destination with exactly these terms. */
export type ModelEgressBinding = ModelEndpointTerms;

/** The per-request check the egress-classified transport calls (structurally connectors/http EgressCheck). */
export interface ModelEgressCheck {
  readonly binding: ModelEgressBinding;
  assertAllowed(target: URL, dataClass: Classification): EgressDestination;
}

const RESTRICTED_CLASSES: readonly Classification[] = ["PHI", "PHI_RESTRICTED", "FINANCIAL", "VERIFICATION_SECRET"];

/** Hard-rule violations for one destination (empty = acceptable). */
export function destinationViolations(d: EgressDestination, environment: Environment): string[] {
  const v: string[] = [];
  for (const cls of d.allowedClasses) {
    if (cls === "VERIFICATION_SECRET" && d.kind !== "VERIFICATION_SERVICE") v.push(`${d.destinationId}:VERIFICATION_SECRET_ONLY_TO_VERIFICATION_SERVICE`);
    if (CONTENT_FREE_ONLY_KINDS.has(d.kind) && !CONTENT_FREE_CLASSES.includes(cls)) v.push(`${d.destinationId}:CONTENT_FREE_ONLY_DESTINATION`);
    if ((isPhiClass(cls) || cls === "FINANCIAL") && !PHI_CAPABLE_KINDS.has(d.kind)) v.push(`${d.destinationId}:PHI_TO_NON_PHI_DESTINATION_KIND`);
    if ((isPhiClass(cls) || cls === "FINANCIAL") && (d.coverage.baaRef === null || d.coverage.approvalId === null)) v.push(`${d.destinationId}:PHI_COVERAGE_OR_APPROVAL_MISSING`);
    if (cls === "VERIFICATION_SECRET" && d.coverage.approvalId === null) v.push(`${d.destinationId}:SECRET_DESTINATION_APPROVAL_MISSING`);
  }
  if (environment === "production" && d.adapterKind === "local_fixture" && d.environments.includes("production")) v.push(`${d.destinationId}:FIXTURE_DESTINATION_IN_PRODUCTION`);
  if (MODEL_CLASS_KINDS.has(d.kind)) {
    if (d.model === undefined) v.push(`${d.destinationId}:MODEL_ENDPOINT_TERMS_MISSING`);
    // A `local` region (emulator, local weights) is never approved for a deployed environment.
    else if (d.model.region === "local" && d.environments.some((e) => e !== "local" && e !== "ci")) v.push(`${d.destinationId}:MODEL_LOCAL_REGION_OUTSIDE_LOCAL`);
  } else if (d.model !== undefined) v.push(`${d.destinationId}:MODEL_TERMS_ON_NON_MODEL_DESTINATION`);
  return v;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class EgressGuard {
  private readonly destinations: readonly EgressDestination[];
  private readonly byId = new Map<string, EgressDestination>();
  private readonly byHost = new Map<string, EgressDestination>();
  readonly policyVersion: string;
  private readonly environment: Environment;
  private readonly logger: Logger;
  private readonly metrics: Metrics | null;

  /** `metrics`: content-free vsp_egress_denied_total{reason} for every refused payload. */
  constructor(config: EgressPolicyConfig, opts: { environment: Environment; logger?: Logger; metrics?: Metrics }) {
    const parsed = EgressPolicyConfig.safeParse(config);
    if (!parsed.success) throw new ConfigurationRejectedError(["EGRESS_CONFIG_INVALID"]);
    this.environment = Environment.parse(opts.environment);
    this.logger = opts.logger ?? silentLogger;
    this.metrics = opts.metrics ?? null;
    const violations: string[] = [];
    for (const d of parsed.data.destinations) {
      violations.push(...destinationViolations(d, this.environment));
      if (this.byId.has(d.destinationId)) violations.push(`${d.destinationId}:DUPLICATE_DESTINATION_ID`);
      this.byId.set(d.destinationId, d);
      for (const h of d.hosts) {
        if (this.byHost.has(h)) violations.push(`${d.destinationId}:DUPLICATE_HOST`);
        this.byHost.set(h, d);
      }
    }
    if (violations.length > 0) throw new ConfigurationRejectedError(violations);
    this.destinations = parsed.data.destinations;
    this.policyVersion = parsed.data.policyVersion;
  }

  list(): readonly EgressDestination[] {
    return this.destinations;
  }

  private countDenied(reason: string): void {
    try {
      this.metrics?.increment("vsp_egress_denied_total", { reason });
    } catch {
      // Metrics never turn a denial into an allow.
    }
  }

  /** Non-throwing evaluation; every denial is counted (content-free reason code only). */
  check(target: EgressTarget, dataClass: Classification): EgressDecision {
    const decision = this.evaluate(target, dataClass);
    if (!decision.allowed) this.countDenied(decision.reasonCode);
    return decision;
  }

  private evaluate(target: EgressTarget, dataClass: Classification): EgressDecision {
    const cls = Classification.safeParse(dataClass);
    if (!cls.success) return { allowed: false, reasonCode: "EGRESS_CLASS_INVALID", destinationId: null };
    const resolved = this.resolve(target);
    if ("reasonCode" in resolved) return { allowed: false, reasonCode: resolved.reasonCode, destinationId: null };
    const d = resolved.destination;
    const deny = (reasonCode: string): EgressDecision => ({ allowed: false, reasonCode, destinationId: d.destinationId });
    if (!d.environments.includes(this.environment)) return deny("EGRESS_ENVIRONMENT_NOT_APPROVED");
    // Hard rules re-applied at decision time (defense in depth against mutated config objects).
    if (destinationViolations(d, this.environment).length > 0) return deny("EGRESS_DESTINATION_VIOLATES_HARD_RULE");
    if (RESTRICTED_CLASSES.includes(cls.data) && CONTENT_FREE_ONLY_KINDS.has(d.kind)) {
      return deny(isPhiClass(cls.data) ? "EGRESS_PHI_TO_CONTENT_FREE_DESTINATION" : "EGRESS_RESTRICTED_TO_CONTENT_FREE_DESTINATION");
    }
    if (!d.allowedClasses.includes(cls.data)) return deny(isPhiClass(cls.data) ? "EGRESS_PHI_NOT_APPROVED_FOR_DESTINATION" : "EGRESS_CLASS_NOT_APPROVED_FOR_DESTINATION");
    return { allowed: true, reasonCode: "EGRESS_ALLOWED", destinationId: d.destinationId };
  }

  /**
   * Model endpoint classes (WP-08): the target must resolve to a MODEL_PROVIDER_API or MODEL_SELF_HOSTED
   * destination approved for the data class AND for exactly the binding's provider, region and retention terms.
   * The generic MODEL_ENDPOINT kind and every other kind are refused (`EGRESS_NOT_A_MODEL_ENDPOINT`), so a model
   * request can never reach a system of record or a destination approved under different model terms.
   */
  checkModelEndpoint(target: EgressTarget, dataClass: Classification, binding: ModelEgressBinding): EgressDecision {
    const decision = this.evaluateModel(target, dataClass, binding);
    if (!decision.allowed) this.countDenied(decision.reasonCode);
    return decision;
  }

  /**
   * The same decision as `checkModelEndpoint`, WITHOUT counting a denial: for callers that only ask what the guard
   * would decide (the invocation audit record of a call the transport already checked, `invocationEgressCheck`), so
   * one refused payload is counted once in vsp_egress_denied_total, by the check that actually refused it.
   */
  peekModelEndpoint(target: EgressTarget, dataClass: Classification, binding: ModelEgressBinding): EgressDecision {
    return this.evaluateModel(target, dataClass, binding);
  }

  private evaluateModel(target: EgressTarget, dataClass: Classification, binding: ModelEgressBinding): EgressDecision {
    const decision = this.evaluate(target, dataClass);
    if (!decision.allowed) return decision;
    const d = this.byId.get(decision.destinationId ?? "");
    const deny = (reasonCode: string): EgressDecision => ({ allowed: false, reasonCode, destinationId: decision.destinationId });
    if (!d || !MODEL_CLASS_KINDS.has(d.kind) || d.model === undefined) return deny("EGRESS_NOT_A_MODEL_ENDPOINT");
    const b = ModelEndpointTerms.safeParse(binding);
    if (!b.success) return deny("EGRESS_MODEL_BINDING_INVALID");
    if (d.model.provider !== b.data.provider) return deny("EGRESS_MODEL_PROVIDER_NOT_APPROVED");
    if (d.model.region !== b.data.region) return deny("EGRESS_MODEL_REGION_NOT_APPROVED");
    if (d.model.retentionPolicyRef !== b.data.retentionPolicyRef) return deny("EGRESS_MODEL_RETENTION_NOT_APPROVED");
    return decision;
  }

  /** Throws AccessDeniedError (reason code only) unless the model endpoint egress is approved for the binding. */
  assertModelEndpoint(target: EgressTarget, dataClass: Classification, binding: ModelEgressBinding): EgressDestination {
    const decision = this.checkModelEndpoint(target, dataClass, binding);
    if (!decision.allowed) {
      this.logger.warn("privacy.egress.denied", { reasonCode: decision.reasonCode, destinationId: decision.destinationId, kind: String(dataClass) });
      throw new AccessDeniedError(decision.reasonCode);
    }
    const d = this.byId.get(decision.destinationId ?? "");
    if (!d) throw new AccessDeniedError("EGRESS_DESTINATION_UNKNOWN");
    return d;
  }

  /**
   * The per-request egress check of one model adapter (passed to the egress-classified transport as its
   * `egress`): every request is checked against the model classes and the binding. The binding is copied
   * and frozen, so a caller cannot widen it after construction.
   */
  forModelEndpoint(binding: ModelEgressBinding): ModelEgressCheck {
    const parsed = ModelEndpointTerms.safeParse(binding);
    if (!parsed.success) throw new ConfigurationRejectedError(["EGRESS_MODEL_BINDING_INVALID"]);
    const frozen = Object.freeze({ ...parsed.data });
    return Object.freeze({
      binding: frozen,
      assertAllowed: (target: URL, dataClass: Classification) => this.assertModelEndpoint(target, dataClass, frozen),
    });
  }

  /** Throws AccessDeniedError (reason code only) unless the egress is approved. */
  assertAllowed(target: EgressTarget, dataClass: Classification): EgressDestination {
    const decision = this.check(target, dataClass);
    if (!decision.allowed) {
      this.logger.warn("privacy.egress.denied", { reasonCode: decision.reasonCode, destinationId: decision.destinationId, kind: String(dataClass) });
      throw new AccessDeniedError(decision.reasonCode);
    }
    const d = this.byId.get(decision.destinationId ?? "");
    if (!d) throw new AccessDeniedError("EGRESS_DESTINATION_UNKNOWN");
    return d;
  }

  /**
   * Telemetry/analytics exporters pass content-free records only. Every string
   * value is scanned for PHI-like patterns; any hit blocks the export.
   */
  assertContentFreeTelemetry(target: EgressTarget, record: Readonly<Record<string, string | number | boolean | null>>): void {
    const d = this.assertAllowed(target, "INTERNAL");
    if (d.kind !== "TELEMETRY_EXPORTER" && d.kind !== "ANALYTICS_SINK" && d.kind !== "AUDIT_SINK") {
      this.countDenied("EGRESS_NOT_A_TELEMETRY_DESTINATION");
      throw new AccessDeniedError("EGRESS_NOT_A_TELEMETRY_DESTINATION");
    }
    for (const [key, value] of Object.entries(record)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.]{0,63}$/.test(key)) {
        this.countDenied("EGRESS_TELEMETRY_KEY_INVALID");
        throw new AccessDeniedError("EGRESS_TELEMETRY_KEY_INVALID");
      }
      if (typeof value === "string" && (value.length > 256 || detectSensitiveSpans(value).length > 0)) {
        this.logger.warn("privacy.egress.telemetry_blocked", { reasonCode: "EGRESS_TELEMETRY_NOT_CONTENT_FREE", destinationId: d.destinationId });
        this.countDenied("EGRESS_TELEMETRY_NOT_CONTENT_FREE");
        throw new AccessDeniedError("EGRESS_TELEMETRY_NOT_CONTENT_FREE");
      }
    }
  }

  private resolve(target: EgressTarget): { destination: EgressDestination } | { reasonCode: string } {
    if (typeof target === "object" && !(target instanceof URL)) {
      const d = this.byId.get(target.destinationId);
      return d ? { destination: d } : { reasonCode: "EGRESS_DESTINATION_UNKNOWN" };
    }
    if (typeof target === "string" && /^egr_[a-z0-9_]{3,40}$/.test(target)) {
      const d = this.byId.get(target);
      return d ? { destination: d } : { reasonCode: "EGRESS_DESTINATION_UNKNOWN" };
    }
    let url: URL;
    try {
      url = target instanceof URL ? target : new URL(target);
    } catch {
      return { reasonCode: "EGRESS_URL_INVALID" };
    }
    if (url.username || url.password) return { reasonCode: "EGRESS_URL_USERINFO_FORBIDDEN" };
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") {
      const loopbackOk = url.protocol === "http:" && LOOPBACK.has(host) && (this.environment === "local" || this.environment === "ci");
      if (!loopbackOk) return { reasonCode: "EGRESS_URL_INSECURE" };
    }
    const key = url.port ? `${host}:${url.port}` : host;
    const d = this.byHost.get(key);
    // The sensitive-pattern scan comes first (same reason code as before for an unknown host); only the reviewed
    // opaque path identifiers of the destination the host names are exempt.
    if (urlCarriesSensitivePattern(url, { opaquePathIds: d?.opaquePathIds ?? [] })) return { reasonCode: "EGRESS_URL_CONTAINS_SENSITIVE_PATTERN" };
    return d ? { destination: d } : { reasonCode: "EGRESS_DESTINATION_UNKNOWN" };
  }
}

/**
 * PHI-like patterns in a URL path, query or fragment. Opaque ids are allowed; long digit runs, emails,
 * phone/SSN/date shapes and Luhn-valid card numbers are not.
 *
 * Opaque tokens, as whole tokens only:
 *  - platform ids (`newId` output, OPAQUE_TOKEN) anywhere in the path, query or fragment;
 *  - the destination's reviewed `opaquePathIds` (canonical UUID constants from the egress configuration, e.g. a
 *    hosted IdP's tenant id in its issuer path), as a WHOLE path segment only, compared case-insensitively.
 * Nothing else is exempt (WP-08 decision on the wave B3 hand-off): a UUID-shaped segment that is not a listed
 * constant is scanned like any other text, because the RFC 9562 layout can carry decimal data (a phone number,
 * an SSN or a record number in its groups, plus a few hex letters to look random). A segment that contains a
 * listed identifier together with anything else is refused when that remainder has a digit, so the exemption
 * never extends to what surrounds the constant; query and fragment values never use the exemption.
 */
export function urlCarriesSensitivePattern(url: URL, opts: { opaquePathIds?: readonly string[] } = {}): boolean {
  let path: string;
  let rest: string;
  try {
    path = decodeURIComponent(url.pathname);
    rest = decodeURIComponent(`${url.search} ${url.hash}`);
  } catch {
    return true;
  }
  const approved = new Set((opts.opaquePathIds ?? []).map((id) => id.toLowerCase()));
  // Opaque identifiers (newId output) are random and allowed as whole tokens anywhere.
  const platformIds = (text: string) =>
    text
      .split(/([/?&=#+\s]+)/)
      .map((tok) => (OPAQUE_TOKEN.test(tok) ? "x" : tok))
      .join("");
  const segments = path.split("/");
  if (approved.size > 0) {
    for (const segment of segments) {
      const lower = segment.toLowerCase();
      if (approved.has(lower)) continue;
      let remainder = lower;
      for (const id of approved) remainder = remainder.split(id).join(" ");
      // Digits next to a listed identifier inside one segment (`<id>5550100123`, `555-0100-<id>`): refused outright.
      if (remainder !== lower && /\d/.test(remainder)) return true;
    }
  }
  const scannedPath = segments.map((segment) => (approved.has(segment.toLowerCase()) ? "x" : platformIds(segment))).join("/");
  const scanned = `${scannedPath} ${platformIds(rest)}`.replace(/[/?&=#+]/g, " ");
  const spans = detectSensitiveSpans(scanned);
  for (const s of spans) {
    if (s.type !== "DIGITS") return true;
    const digits = scanned.slice(s.start, s.end).replace(/\D/g, "");
    if (digits.length >= 9 || luhnValid(digits)) return true;
  }
  return false;
}

const OPAQUE_TOKEN = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
