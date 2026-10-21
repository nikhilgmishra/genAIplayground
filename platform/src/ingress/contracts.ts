/**
 * Explicit inbound event contracts and classification (follow-on FO-07-21, FO-07-19; DATA-01, OPS-03).
 *
 * A source profile maps each event type it may deliver to a reviewed contract (a strict zod schema in
 * code, versioned). Classification of a received payload:
 *   - JSON that cannot be parsed, or no event id in the envelope      -> QUARANTINED (PAYLOAD_UNPARSEABLE)
 *   - an event type the profile does not list                         -> QUARANTINED (UNKNOWN_EVENT_TYPE)
 *   - a listed type whose contract is not registered in this build    -> QUARANTINED (CONTRACT_UNAVAILABLE)
 *   - a payload with a field the contract does not declare            -> QUARANTINED (UNKNOWN_FIELD)
 *   - any other contract violation                                    -> QUARANTINED (SCHEMA_VIOLATION)
 *   - otherwise                                                       -> RECEIVED with schema id/version
 * Quarantined events are stored (encrypted) and alarmed, never projected: an unclassified field is never
 * promoted into context. Classification never echoes payload values; it returns codes and opaque ids.
 */
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { SourceProfile } from "./profile.js";

export interface InboundContract {
  contractId: string;
  version: string;
  /** Strict schema of the whole payload (unknown fields fail). */
  schema: z.ZodType;
}

export type QuarantineReason = "PAYLOAD_UNPARSEABLE" | "UNKNOWN_EVENT_TYPE" | "CONTRACT_UNAVAILABLE" | "UNKNOWN_FIELD" | "SCHEMA_VIOLATION";

export interface Classification {
  eventId: string;
  eventType: string | null;
  occurredAt: string | null;
  /** Decimal string (up to 39 digits) when the source carries an ordering version. */
  sourceVersion: string | null;
  entityKey: string | null;
  contract: { contractId: string; version: string } | null;
  quarantine: QuarantineReason | null;
  /** The parsed payload when classification succeeded (validated by the contract). */
  payload: unknown;
}

const EVENT_ID = /^[A-Za-z0-9:._/=+-]{1,200}$/;
const EVENT_TYPE = /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/;
const ENTITY = /^[A-Za-z0-9:._/=+-]{1,200}$/;

export class InboundContractRegistry {
  private readonly contracts = new Map<string, InboundContract>();

  constructor(contracts: readonly InboundContract[] = []) {
    for (const c of contracts) this.register(c);
  }

  register(c: InboundContract): this {
    const key = `${c.contractId}@${c.version}`;
    if (this.contracts.has(key)) throw new Error(`duplicate inbound contract ${key}`);
    this.contracts.set(key, c);
    return this;
  }

  get(contractId: string, version: string): InboundContract | null {
    return this.contracts.get(`${contractId}@${version}`) ?? null;
  }
}

/** Surrogate event id for a payload whose own id cannot be read: the digest of its bytes (dedupes exact redeliveries). */
export const digestEventId = (raw: Buffer): string => `digest:${createHash("sha256").update(raw).digest("hex")}`;

function scalar(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  return null;
}

export function classify(raw: Buffer, profile: SourceProfile, registry: InboundContractRegistry): Classification {
  const base: Classification = { eventId: digestEventId(raw), eventType: null, occurredAt: null, sourceVersion: null, entityKey: null, contract: null, quarantine: "PAYLOAD_UNPARSEABLE", payload: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return base;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return base;
  const o = parsed as Record<string, unknown>;
  const env = profile.envelope;
  const id = scalar(o[env.idField]);
  if (id === null || !EVENT_ID.test(id)) return base;
  const type = scalar(o[env.typeField]);
  const occurred = env.occurredAtField ? scalar(o[env.occurredAtField]) : null;
  const version = env.versionField ? scalar(o[env.versionField]) : null;
  const entity = env.entityField ? scalar(o[env.entityField]) : null;
  const out: Classification = {
    ...base,
    eventId: id,
    eventType: type !== null && EVENT_TYPE.test(type) ? type : null,
    occurredAt: occurred !== null && !Number.isNaN(Date.parse(occurred)) && /^\d{4}-\d{2}-\d{2}T/.test(occurred) ? new Date(occurred).toISOString() : null,
    sourceVersion: version !== null && /^[0-9]{1,39}$/.test(version) ? version : null,
    entityKey: entity !== null && ENTITY.test(entity) ? entity : null,
    quarantine: null,
  };
  if (out.eventType === null || !Object.hasOwn(profile.contracts, out.eventType)) return { ...out, quarantine: "UNKNOWN_EVENT_TYPE" };
  const ref = profile.contracts[out.eventType];
  const contract = ref ? registry.get(ref.contractId, ref.version) : null;
  if (!ref || !contract) return { ...out, quarantine: "CONTRACT_UNAVAILABLE" };
  const r = contract.schema.safeParse(parsed);
  if (!r.success) {
    const unknownField = r.error.issues.some((i) => i.code === "unrecognized_keys");
    return { ...out, contract: { contractId: ref.contractId, version: ref.version }, quarantine: unknownField ? "UNKNOWN_FIELD" : "SCHEMA_VIOLATION" };
  }
  return { ...out, contract: { contractId: ref.contractId, version: ref.version }, payload: r.data };
}
