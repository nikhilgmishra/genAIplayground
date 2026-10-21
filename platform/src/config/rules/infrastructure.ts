/**
 * Infrastructure inputs of the live composition (WP-07; FO-19-06, FO-14-53, OPS-01, AUTH-02).
 *
 * The live container builds its AWS clients, the outbox publisher, the Object Lock audit sink, the independent
 * route-audit journal and the startup secrets from `infrastructure`. Blocking (mandatory substrate): the block
 * itself, the outbox queue (and, in staging and production, its dead-letter queue), the route-audit journal
 * table, the audit sink when audit uses Object Lock, and the request-hash pepper. Capability-level (one capability NOT_CONFIGURED): the independent audit export
 * (audit.independent), the OTP pepper (identity.caller), the console session sealer (operator.console) and the
 * ingress payload key (ingress.events).
 *
 * No development bypass reaches staging or production (FO-14-53): AWS endpoint overrides (emulators) are
 * accepted in sandbox only, and only for emulator host names; staging and production refuse every override.
 * The audit exporter and verifier run under identities separate from the runtime and from each other.
 *
 * Trusted proxies (STRIDE D): `trustedProxyCidrs` are the load balancer ranges whose X-Forwarded-For the
 * console's sign-in rate limit believes. Each must be a private range (a public or catch-all range would let
 * any client choose its own rate-limit key). In staging and production the console runs behind the load
 * balancer, so without them every operator shares the balancer's address and one anonymous client could lock
 * them all out of sign-in: operator.console is NOT_CONFIGURED until they are set.
 */
import { isPrivateCidr, parseCidr } from "../../shared/cidr.js";
import { isEmulatorEndpoint } from "../../shared/emulator-hosts.js";
import { LIVE_RULE_SETS, isPlaceholder, refProblem, sameKeyOrSecret } from "./types.js";
import type { GuardRule } from "./types.js";

const OVERRIDE_KEYS = ["dynamodb", "sqs", "s3", "kms", "secretsManager", "sts"] as const;

export const infrastructureRule: GuardRule = {
  id: "infrastructure",
  file: "infrastructure.ts",
  ruleSets: LIVE_RULE_SETS,
  evaluate({ config, ruleSet, v }) {
    const infra = config.infrastructure;
    if (!infra) {
      v.add("INFRASTRUCTURE_NOT_CONFIGURED", "infrastructure");
      return;
    }
    const overrides = infra.aws.endpointOverrides;
    if (overrides) {
      for (const k of OVERRIDE_KEYS) {
        const o = overrides[k];
        if (o === null) continue;
        const path = `infrastructure.aws.endpointOverrides.${k}`;
        if (ruleSet === "full") v.add("INFRASTRUCTURE_ENDPOINT_OVERRIDE_FORBIDDEN", path);
        // The AWS client factory applies the same check before any client exists (aws-clients.ts).
        else if (!isEmulatorEndpoint(o)) v.add("INFRASTRUCTURE_ENDPOINT_OVERRIDE_NOT_EMULATOR", path);
      }
    }
    if (ruleSet === "full" && infra.aws.s3ForcePathStyle) v.add("INFRASTRUCTURE_S3_PATH_STYLE_OUTSIDE_EMULATOR", "infrastructure.aws.s3ForcePathStyle");

    if (!infra.outbox) v.add("OUTBOX_QUEUE_NOT_CONFIGURED", "infrastructure.outbox");
    else {
      if (isPlaceholder(infra.outbox.queueUrl)) v.add("OUTBOX_QUEUE_PLACEHOLDER", "infrastructure.outbox.queueUrl");
      if (infra.outbox.fifo !== infra.outbox.queueUrl.endsWith(".fifo")) v.add("OUTBOX_QUEUE_FIFO_MISMATCH", "infrastructure.outbox.fifo");
      if (infra.outbox.deadLetterQueueUrl === infra.outbox.queueUrl) v.add("OUTBOX_DLQ_IS_SOURCE_QUEUE", "infrastructure.outbox.deadLetterQueueUrl");
      // OPS-01: without a dead-letter queue (and its redrive policy on the outbox queue) one poison message keeps
      // the consume loop failing on every run and worker readiness at 503 indefinitely. Required in staging and
      // production; a sandbox may run without it.
      if (ruleSet === "full" && infra.outbox.deadLetterQueueUrl === null) v.add("OUTBOX_DLQ_NOT_CONFIGURED", "infrastructure.outbox.deadLetterQueueUrl");
      else if (isPlaceholder(infra.outbox.deadLetterQueueUrl)) v.add("OUTBOX_DLQ_PLACEHOLDER", "infrastructure.outbox.deadLetterQueueUrl");
    }
    if (!infra.routeAuditJournalTable) v.add("AUDIT_JOURNAL_TABLE_NOT_CONFIGURED", "infrastructure.routeAuditJournalTable");
    else if (isPlaceholder(infra.routeAuditJournalTable)) v.add("AUDIT_JOURNAL_TABLE_PLACEHOLDER", "infrastructure.routeAuditJournalTable");

    if (config.audit.sink === "s3_object_lock") {
      if (!infra.auditSink) v.add("AUDIT_SINK_BUCKET_NOT_CONFIGURED", "infrastructure.auditSink");
      else {
        if (isPlaceholder(infra.auditSink.bucket) || infra.auditSink.bucket.includes("placeholder")) v.add("AUDIT_SINK_BUCKET_PLACEHOLDER", "infrastructure.auditSink.bucket");
        if (config.environment === "production" && infra.auditSink.objectLockMode !== "COMPLIANCE") v.add("AUDIT_SINK_OBJECT_LOCK_NOT_COMPLIANCE", "infrastructure.auditSink.objectLockMode");
      }
    }
    const pepper = refProblem(infra.secrets.requestHashPepperRef, "REQUEST_HASH_PEPPER_REF");
    if (pepper) v.add(pepper, "infrastructure.secrets.requestHashPepperRef");

    const proxies = infra.trustedProxyCidrs ?? [];
    for (const [i, raw] of proxies.entries()) {
      const c = parseCidr(raw);
      if (!c) v.add("TRUSTED_PROXY_CIDR_INVALID", `infrastructure.trustedProxyCidrs.${i}`);
      else if (!isPrivateCidr(c)) v.add("TRUSTED_PROXY_CIDR_NOT_PRIVATE", `infrastructure.trustedProxyCidrs.${i}`);
    }
    if (ruleSet === "full" && proxies.length === 0) v.capability("operator.console", "console-edge", "CONSOLE_TRUSTED_PROXY_NOT_CONFIGURED", "infrastructure.trustedProxyCidrs");

    // Capability-level inputs.
    const otp = refProblem(infra.secrets.otpPepperRef, "OTP_PEPPER_REF");
    if (otp) v.capability("identity.caller", "otp-pepper", otp, "infrastructure.secrets.otpPepperRef");
    const sealer = refProblem(infra.secrets.consoleSessionSealerRef, "CONSOLE_SESSION_SEALER_REF");
    if (sealer) v.capability("operator.console", "console-session-sealer", sealer, "infrastructure.secrets.consoleSessionSealerRef");
    if (!infra.ingressPayloadKeyId) v.capability("ingress.events", "ingress-payload-key", "INGRESS_PAYLOAD_KEY_NOT_CONFIGURED", "infrastructure.ingressPayloadKeyId");
    if (!infra.auditExport) v.capability("audit.independent", "audit-export", "AUDIT_EXPORT_NOT_CONFIGURED", "infrastructure.auditExport");
    else {
      const ex = infra.auditExport;
      const exp = refProblem(ex.exporterDatabaseRef, "AUDIT_EXPORTER_DATABASE_REF");
      if (exp) v.capability("audit.independent", "audit-export", exp, "infrastructure.auditExport.exporterDatabaseRef");
      const ver = refProblem(ex.verifierDatabaseRef, "AUDIT_VERIFIER_DATABASE_REF");
      if (ver) v.capability("audit.independent", "audit-export", ver, "infrastructure.auditExport.verifierDatabaseRef");
      // Separation of identities (AUTH-02): a shared login defeats the exporter/verifier split. Compared by secret
      // identity (a full Secrets Manager ARN names the same secret as its partial ARN), never by spelling.
      if (sameKeyOrSecret(ex.exporterDatabaseRef, config.database.connectionRef)) v.add("AUDIT_EXPORT_IDENTITY_SHARED", "infrastructure.auditExport.exporterDatabaseRef");
      if (sameKeyOrSecret(ex.verifierDatabaseRef, config.database.connectionRef) || sameKeyOrSecret(ex.verifierDatabaseRef, ex.exporterDatabaseRef)) v.add("AUDIT_EXPORT_IDENTITY_SHARED", "infrastructure.auditExport.verifierDatabaseRef");
      if (!ex.trustedManifestKeyIds.includes(ex.manifestSigningKeyId)) v.capability("audit.independent", "audit-export", "AUDIT_MANIFEST_KEY_UNTRUSTED", "infrastructure.auditExport.trustedManifestKeyIds");
    }
  },
};
