/**
 * Liveness and readiness (infra contract: ECS container health checks and the
 * ALB target group probe GET /health/live and GET /health/ready).
 *
 * Readiness reports not-ready (503) when any of: the database cannot answer,
 * the policy bundle is not loaded (fail-closed engine), audit evidence cannot be
 * accepted (bounded-buffer policy exceeded or store unwritable), or the
 * configuration guard did not pass. Content-free: component names and reason
 * codes only. Unauthenticated by design (load balancer), so it discloses no
 * versions, digests or tenant data.
 */
import { z } from "zod";
import type { AuditHealth } from "../../audit/ports.js";
import type { Db } from "../../db/types.js";
import type { PolicyEngine } from "../../policy/ports.js";
import { PlatformError } from "../../shared/errors.js";
import { defineRoute } from "./route.js";
import type { RouteDef } from "./route.js";

export const ReadinessCheck = z.strictObject({ ok: z.boolean(), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).nullable() });
export const ReadinessBody = z.strictObject({
  ready: z.boolean(),
  checks: z.strictObject({ database: ReadinessCheck, policyBundle: ReadinessCheck, audit: ReadinessCheck, configGuard: ReadinessCheck }),
});
export type ReadinessBody = z.infer<typeof ReadinessBody>;
export const LivenessBody = z.strictObject({ status: z.literal("live") });

export interface ReadinessDeps {
  db: Db;
  policy: PolicyEngine;
  auditHealth: AuditHealth;
  /** True only when the configuration guard accepted this configuration at startup. */
  configGuardPassed: boolean;
}

const reason = (err: unknown, fallback: string) => (err instanceof PlatformError && /^[A-Z][A-Z0-9_]{2,63}$/.test(err.reasonCode) ? err.reasonCode : fallback);

export class ReadinessProbe {
  constructor(private readonly deps: ReadinessDeps) {}

  async check(): Promise<ReadinessBody> {
    const database = await this.deps.db
      .query("select 1 as ok")
      .then(() => ({ ok: true, reasonCode: null }))
      .catch((e: unknown) => ({ ok: false, reasonCode: reason(e, "DATABASE_UNAVAILABLE") }));
    const failClosed = this.deps.policy.policyVersion === "unavailable" || /^0{64}$/.test(this.deps.policy.bundleDigest);
    const policyBundle = failClosed ? { ok: false, reasonCode: "POLICY_BUNDLE_NOT_LOADED" } : { ok: true, reasonCode: null };
    const audit = await this.deps.auditHealth
      .status()
      .then((s) => (s.canAcceptConsequential ? { ok: true, reasonCode: null } : { ok: false, reasonCode: s.reasonCode && /^[A-Z][A-Z0-9_]{2,63}$/.test(s.reasonCode) ? s.reasonCode : "AUDIT_UNAVAILABLE" }))
      .catch((e: unknown) => ({ ok: false, reasonCode: reason(e, "AUDIT_UNAVAILABLE") }));
    const configGuard = this.deps.configGuardPassed ? { ok: true, reasonCode: null } : { ok: false, reasonCode: "CONFIG_GUARD_NOT_PASSED" };
    const checks = { database, policyBundle, audit, configGuard };
    return { ready: Object.values(checks).every((c) => c.ok), checks };
  }
}

export function healthRoutes(probe: ReadinessProbe): RouteDef<unknown, unknown>[] {
  return [
    defineRoute({
      operationId: "health.live",
      method: "GET",
      path: "/health/live",
      channel: null,
      summary: "Process liveness (no dependencies checked).",
      tags: ["health"],
      rateLimitExempt: true,
      responses: { 200: { description: "Live", schema: LivenessBody } },
      handler: async () => ({ status: 200, body: { status: "live" } }),
    }),
    defineRoute({
      operationId: "health.ready",
      method: "GET",
      path: "/health/ready",
      channel: null,
      summary: "Readiness: database, policy bundle, audit evidence health and configuration guard.",
      tags: ["health"],
      rateLimitExempt: true,
      responses: { 200: { description: "Ready", schema: ReadinessBody }, 503: { description: "Not ready (fail closed)", schema: ReadinessBody } },
      handler: async () => {
        const body = await probe.check();
        return { status: body.ready ? 200 : 503, body };
      },
    }),
  ] as RouteDef<unknown, unknown>[];
}
