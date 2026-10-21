/**
 * Helpers for other modules to build a valid AuditEventInput with minimal
 * boilerplate. Defaults: dataClass SECURITY_AUDIT, every optional reference null,
 * no evidence pointers. The result is validated with the writer's strict schema,
 * so an invalid field fails here (AuditEventInvalidError) rather than at append.
 */
import type { AuditEventInput, AuthContext } from "../protocol/index.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import { ValidationError } from "../shared/errors.js";
import { validateAuditInput } from "./schema.js";

type RequiredKeys = "tenantId" | "correlationId" | "sourceComponent" | "action" | "outcome";

export type AuditInputFields = Pick<AuditEventInput, RequiredKeys> & Partial<Omit<AuditEventInput, RequiredKeys>>;

export function buildAuditInput(fields: AuditInputFields, clock?: Clock): AuditEventInput {
  const occurredAt = fields.occurredAt ?? (clock ? iso(clock.now()) : undefined);
  if (!occurredAt) throw new ValidationError("AUDIT_EVENT_TIMESTAMP_REQUIRED");
  const input: AuditEventInput = {
    occurredAt,
    correlationId: fields.correlationId,
    parentId: fields.parentId ?? null,
    tenantId: fields.tenantId,
    actorRef: fields.actorRef ?? null,
    subjectRef: fields.subjectRef ?? null,
    role: fields.role ?? null,
    sourceComponent: fields.sourceComponent,
    callId: fields.callId ?? null,
    sessionRef: fields.sessionRef ?? null,
    sessionGeneration: fields.sessionGeneration ?? null,
    turnId: fields.turnId ?? null,
    versions: fields.versions ?? null,
    action: fields.action,
    policyDecision: fields.policyDecision ?? null,
    assurance: fields.assurance ?? null,
    evidencePointers: fields.evidencePointers ?? [],
    beforeHash: fields.beforeHash ?? null,
    afterHash: fields.afterHash ?? null,
    idempotencyKey: fields.idempotencyKey ?? null,
    outcome: fields.outcome,
    reasonCode: fields.reasonCode ?? null,
    dataClass: fields.dataClass ?? "SECURITY_AUDIT",
    // Follow-on evidence fields (FO-15-34): set only when given, so events without them hash as before.
    ...(fields.causationId !== undefined ? { causationId: fields.causationId } : {}),
    ...(fields.sourceSequence !== undefined ? { sourceSequence: fields.sourceSequence } : {}),
    ...(fields.contextSnapshotId !== undefined ? { contextSnapshotId: fields.contextSnapshotId } : {}),
    ...(fields.configDigest !== undefined ? { configDigest: fields.configDigest } : {}),
    ...(fields.receiptRefs !== undefined ? { receiptRefs: fields.receiptRefs } : {}),
    ...(fields.ingress !== undefined ? { ingress: fields.ingress } : {}),
  };
  return validateAuditInput(input);
}

/**
 * Server-established identity fields from a trusted AuthContext (AUTH-03). The
 * session reference is pseudonymized by the writer before it is stored.
 */
export function auditFieldsFromAuth(
  auth: AuthContext,
): Pick<AuditEventInput, "tenantId" | "actorRef" | "subjectRef" | "role" | "callId" | "sessionRef" | "sessionGeneration" | "assurance"> {
  return {
    tenantId: auth.tenantId,
    actorRef: auth.actorId,
    subjectRef: auth.subjectId,
    role: auth.selectedRole,
    callId: auth.callId,
    sessionRef: auth.sessionRef,
    sessionGeneration: auth.sessionGeneration,
    assurance: auth.assurance,
  };
}
