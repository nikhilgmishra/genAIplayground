/**
 * UNIT FAKE (Docker-free unit tests of platform/src/domain only; never composed, never reachable from production
 * code). An OperationRunner over an ADMITTED reference profile that answers each reviewed operation from a script
 * the test supplies, so the adapters' classification, refusal mapping and reconciliation decisions can be tested
 * without a network. The Layer-2 suite (platform/test/integration/domain) runs the same adapters over the real
 * connector runtime, TLS transport and the reference business API container.
 */
import type { MappedRecord } from "../connectors/dsl/mapping.js";
import type { MappedValue } from "../connectors/dsl/values.js";
import { admitConnectorProfile } from "../connectors/profile/validate.js";
import type { AdmittedProfile } from "../connectors/profile/validate.js";
import type { ExecuteInput, OperationResult, PagedResult } from "../connectors/runtime/connector.js";
import type { ConnectorProfile } from "../protocol/connector.js";
import { sha256Hex } from "../shared/canonical.js";
import { admitBinding } from "./binding.js";
import { referenceBinding, referenceProfile } from "./profiles.js";
import type { ReferenceSystem } from "./profiles.js";
import { DomainConnector } from "./runner.js";
import type { OperationRunner } from "./runner.js";

export type ScriptedAnswer = Record<string, MappedValue>[] | Error;
export type Script = (operationId: string, input: ExecuteInput) => ScriptedAnswer;

export interface FakeCall {
  operationId: string;
  input: ExecuteInput;
  kind: "execute" | "reconcile" | "readAll";
}

const record = (values: Record<string, MappedValue>): MappedRecord => ({ values, provenance: {} });

/** UNIT FAKE runner: records every call; answers from the script (an Error is thrown as the runtime would). */
export class ScriptedRunner implements OperationRunner {
  readonly calls: FakeCall[] = [];
  constructor(
    readonly profile: ConnectorProfile,
    private readonly script: Script,
  ) {}

  private answer(operationId: string, input: ExecuteInput): OperationResult {
    const a = this.script(operationId, input);
    if (a instanceof Error) throw a;
    return {
      operationId,
      httpStatus: 200,
      records: a.map(record),
      mappingDigest: "0".repeat(64),
      receipt: { requestDigest: sha256Hex(`req:${operationId}`), responseDigest: sha256Hex(JSON.stringify(a)), secretVersionId: "unit-fake", at: "2026-10-21T12:00:00.000Z" },
      next: null,
    };
  }

  async execute(operationId: string, input: ExecuteInput = {}): Promise<OperationResult> {
    this.calls.push({ operationId, input, kind: "execute" });
    return this.answer(operationId, input);
  }

  async reconcile(writeOperationId: string, input: ExecuteInput): Promise<{ found: boolean; result: OperationResult | null }> {
    this.calls.push({ operationId: writeOperationId, input, kind: "reconcile" });
    const op = this.profile.operations.find((o) => o.operationId === writeOperationId);
    const lookup = op?.reconcileOperationId ?? writeOperationId;
    const r = this.answer(lookup, input);
    return r.records.length === 0 ? { found: false, result: null } : { found: true, result: r };
  }

  async readAll(operationId: string, input: ExecuteInput = {}): Promise<PagedResult> {
    this.calls.push({ operationId, input, kind: "readAll" });
    const r = this.answer(operationId, input);
    return { operationId, records: r.records, pages: 1, completeness: "COMPLETE", truncatedReason: null, nextCursor: null, mappingDigest: r.mappingDigest };
  }

  async health(): Promise<{ healthy: boolean; reasonCode: string | null }> {
    return { healthy: true, reasonCode: null };
  }
}

/** An admitted reference profile + binding of one system (synthetic local-fixture credential references). */
export function admittedReference(
  key: ReferenceSystem,
  o: { windowMs?: number; incompleteWrite?: "COMPLETE_BY_REQUEST_ID" | "ROUTE_TO_HUMAN"; dispatchDeadline?: "REQUEST_NOT_AFTER" | "NONE"; fence?: boolean } = {},
): { admitted: AdmittedProfile; binding: ReturnType<typeof admitBinding> } {
  const profile = referenceProfile(key, {
    tenantId: "tnt_synthUnitTenant000001",
    profileId: `cnp_synthUnit${key}Profile01`,
    occurredAt: "2026-10-21T00:00:00.000Z",
    host: `${key}.refbiz.test`,
    externalAccountRef: "acc_synthUnitAccount00001",
    region: "us-east-1",
    readCredentialRef: `local-fixture:domain/${key}/read`,
    writeCredentialRef: key === "claims" || key === "provider" || key === "referrals" ? null : `local-fixture:domain/${key}/write`,
    writeMode: key === "claims" || key === "provider" || key === "referrals" ? "READ_ONLY" : "SANDBOX_WRITE",
    dialect: key === "legacy" ? "legacy_codes" : "canonical",
    businessTimeZone: "America/Chicago",
    addressClass: "PRIVATE_NETWORK",
    tlsCaRef: null,
    syntheticRecordId: null,
  });
  const admitted = admitConnectorProfile(profile, "local");
  const binding = admitBinding(
    referenceBinding(key, profile, {
      bindingId: `dbn_synthUnit${key}Binding1`,
      visibilityWindowMs: o.windowMs ?? 1_000,
      clockSkewAllowanceMs: 200,
      incompleteWrite: o.incompleteWrite,
      dispatchDeadline: o.dispatchDeadline,
      // A fence needs the dispatch deadline: a system without one has no fence either.
      fence: o.fence ?? o.dispatchDeadline !== "NONE",
      paymentPortalPath: "/billing/pay/{invoiceId}",
    }),
    admitted,
  );
  return { admitted, binding };
}

/** A DomainConnector of one system over a ScriptedRunner (UNIT FAKE). */
export function scriptedConnector(key: ReferenceSystem, script: Script, o: Parameters<typeof admittedReference>[1] = {}, clock?: { now(): Date }): { conn: DomainConnector; runner: ScriptedRunner } {
  const { admitted, binding } = admittedReference(key, o);
  const runner = new ScriptedRunner(admitted.profile, script);
  const system = key === "legacy" ? "scheduling" : key;
  return { conn: new DomainConnector(binding, runner, system, clock ?? { now: () => new Date("2026-10-21T12:00:00.000Z") }), runner };
}
