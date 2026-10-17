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
 *    path or query (no PHI in URLs);
 *  - in production, destinations labelled local_fixture are rejected (OPS-04).
 *
 * Configuration that violates a hard rule is rejected at construction, not
 * silently narrowed. The coverage/approval references are not verified here
 * against signed approval records; the composition root must bind them to the
 * config module's approval loader (see README, BLOCKED).
 */
import { z } from "zod";
import { Classification, Environment } from "../protocol/index.js";
import type { Logger } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import { AccessDeniedError, ConfigurationRejectedError } from "../shared/errors.js";
import { CONTENT_FREE_CLASSES, isPhiClass } from "./classification.js";
import { detectSensitiveSpans, luhnValid } from "./patterns.js";

export const DestinationKind = z.enum([
  "PHI_PROCESSOR",
  "SYSTEM_OF_RECORD",
  "MODEL_ENDPOINT",
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
export const PHI_CAPABLE_KINDS: ReadonlySet<DestinationKind> = new Set(["PHI_PROCESSOR", "SYSTEM_OF_RECORD", "MODEL_ENDPOINT", "RESTRICTED_MEDIA_STORE"]);
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

  constructor(config: EgressPolicyConfig, opts: { environment: Environment; logger?: Logger }) {
    const parsed = EgressPolicyConfig.safeParse(config);
    if (!parsed.success) throw new ConfigurationRejectedError(["EGRESS_CONFIG_INVALID"]);
    this.environment = Environment.parse(opts.environment);
    this.logger = opts.logger ?? silentLogger;
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

  /** Non-throwing evaluation. */
  check(target: EgressTarget, dataClass: Classification): EgressDecision {
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
      throw new AccessDeniedError("EGRESS_NOT_A_TELEMETRY_DESTINATION");
    }
    for (const [key, value] of Object.entries(record)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.]{0,63}$/.test(key)) throw new AccessDeniedError("EGRESS_TELEMETRY_KEY_INVALID");
      if (typeof value === "string" && (value.length > 256 || detectSensitiveSpans(value).length > 0)) {
        this.logger.warn("privacy.egress.telemetry_blocked", { reasonCode: "EGRESS_TELEMETRY_NOT_CONTENT_FREE", destinationId: d.destinationId });
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
    if (urlCarriesSensitivePattern(url)) return { reasonCode: "EGRESS_URL_CONTAINS_SENSITIVE_PATTERN" };
    const key = url.port ? `${host}:${url.port}` : host;
    const d = this.byHost.get(key);
    return d ? { destination: d } : { reasonCode: "EGRESS_DESTINATION_UNKNOWN" };
  }
}

/**
 * PHI-like patterns in a URL path, query or fragment. Opaque ids are allowed; long
 * digit runs, emails, phone/SSN/date shapes and Luhn-valid card numbers are not.
 */
export function urlCarriesSensitivePattern(url: URL): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(`${url.pathname} ${url.search} ${url.hash}`);
  } catch {
    return true;
  }
  // Opaque identifiers (newId output) are random and allowed as whole path/query tokens.
  const scanned = decoded
    .split(/([/?&=#+\s]+)/)
    .map((tok) => (OPAQUE_TOKEN.test(tok) ? "x" : tok))
    .join("")
    .replace(/[/?&=#+]/g, " ");
  const spans = detectSensitiveSpans(scanned);
  for (const s of spans) {
    if (s.type !== "DIGITS") return true;
    const digits = scanned.slice(s.start, s.end).replace(/\D/g, "");
    if (digits.length >= 9 || luhnValid(digits)) return true;
  }
  return false;
}

const OPAQUE_TOKEN = /^[a-z][a-z0-9]{1,11}_[A-Za-z0-9_-]{16,64}$/;
