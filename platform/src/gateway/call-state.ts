/**
 * Small per-call state the gateway keeps for the telephony-control API.
 *
 * - SessionLeaseRegistry: the AI-capacity lease taken by admission at call start
 *   (released at call end). Keyed by sha256 of the bearer reference, never the
 *   bearer. Per process, like InMemorySessionCapacity (multi-instance deployment
 *   needs a shared counter: ops module gap).
 * - HandoffIndex: the latest handoff requested for a call through ANY surface
 *   (telephony-control, MCP/HTTP tools with or without a session, console), fed
 *   by the HandoffService observer, for TC-12 handoff context and TC-11 outcome
 *   evidence. Bounded LRU; opaque ids only.
 * - CallOutcomeTracker: per-call flags the gateway observed server-side (an
 *   informational read succeeded, a policy decision denied a request) for TC-11
 *   outcome evidence. Bounded LRU; never a caller- or model-supplied value.
 * TC-07 and TC-11 read the action ledger through ActionService.listForSession.
 */
import { sessionRefHash } from "../identity/keys.js";
import type { AdmissionDecision } from "../ops/ports.js";
import type { Clock } from "../shared/clock.js";
import { iso } from "../shared/clock.js";
import type { HandoffResult } from "../business/contract.js";
import type { ToolSafetyClass, ToolStatus } from "../protocol/index.js";

export interface LeaseRecord {
  leaseId: string | null;
  decision: Pick<AdmissionDecision, "admitted" | "continuity" | "reasonCode">;
}

export class SessionLeaseRegistry {
  private readonly byHash = new Map<string, LeaseRecord>();
  constructor(private readonly maxEntries = 50_000) {}

  set(sessionRef: string, record: LeaseRecord): void {
    const k = sessionRefHash(sessionRef);
    this.byHash.delete(k);
    this.byHash.set(k, record);
    while (this.byHash.size > this.maxEntries) {
      const oldest = this.byHash.keys().next().value;
      if (oldest === undefined) break;
      this.byHash.delete(oldest);
    }
  }

  get(sessionRef: string): LeaseRecord | null {
    try {
      return this.byHash.get(sessionRefHash(sessionRef)) ?? null;
    } catch {
      return null;
    }
  }

  /** Removes and returns the record (call end). */
  take(sessionRef: string): LeaseRecord | null {
    try {
      const k = sessionRefHash(sessionRef);
      const r = this.byHash.get(k) ?? null;
      this.byHash.delete(k);
      return r;
    } catch {
      return null;
    }
  }

  get size(): number {
    return this.byHash.size;
  }
}

export interface IndexedHandoff {
  handoffId: string;
  transferId: string | null;
  destinationId: string;
  priority: "SAFETY" | "STANDARD";
  /** Internal support reference created for the handoff (pending synchronization), when one was created. */
  supportReference: string | null;
  at: string;
}

export class HandoffIndex {
  private readonly byCall = new Map<string, IndexedHandoff>();
  constructor(
    private readonly clock: Clock,
    private readonly maxEntries = 50_000,
  ) {}

  record(callId: string, result: Pick<HandoffResult, "handoffId" | "transferId" | "destinationId"> & { supportReference?: string | null }, priority: "SAFETY" | "STANDARD"): void {
    const prior = this.byCall.get(callId);
    // A STANDARD request never displaces an active safety handoff for the same call (SAFE-03).
    if (prior?.priority === "SAFETY" && priority === "STANDARD") return;
    // The same handoff reported twice (observer and route) keeps the reference it already had.
    const supportReference = result.supportReference ?? (prior?.handoffId === result.handoffId ? prior.supportReference : null);
    this.byCall.delete(callId);
    this.byCall.set(callId, { handoffId: result.handoffId, transferId: result.transferId, destinationId: result.destinationId, priority, supportReference, at: iso(this.clock.now()) });
    while (this.byCall.size > this.maxEntries) {
      const oldest = this.byCall.keys().next().value;
      if (oldest === undefined) break;
      this.byCall.delete(oldest);
    }
  }

  latest(callId: string): IndexedHandoff | null {
    return this.byCall.get(callId) ?? null;
  }
}

export interface CallOutcomeFlags {
  /** A PUBLIC_READ or PROTECTED_READ tool returned SUCCESS for this call (information was provided). */
  informationProvided: boolean;
  /** A policy decision denied a tool request for this call (DECLINED_BY_POLICY evidence). */
  policyDeclined: boolean;
}

const INFORMATIONAL: ReadonlySet<ToolSafetyClass> = new Set<ToolSafetyClass>(["PUBLIC_READ", "PROTECTED_READ"]);

/** Server-side per-call observations for TC-11 outcome evidence (ACT-04). Per process, bounded LRU. */
export class CallOutcomeTracker {
  private readonly byCall = new Map<string, CallOutcomeFlags>();
  constructor(private readonly maxEntries = 50_000) {}

  /** Called by the tool pipeline with the final status of every invocation bound to a call. */
  observe(callId: string, safetyClass: ToolSafetyClass, status: ToolStatus, policyDenied: boolean): void {
    const informational = status === "SUCCESS" && INFORMATIONAL.has(safetyClass);
    const declined = status === "POLICY_DENIED" && policyDenied;
    if (!informational && !declined) return;
    const prior = this.byCall.get(callId) ?? { informationProvided: false, policyDeclined: false };
    this.byCall.delete(callId);
    this.byCall.set(callId, { informationProvided: prior.informationProvided || informational, policyDeclined: prior.policyDeclined || declined });
    while (this.byCall.size > this.maxEntries) {
      const oldest = this.byCall.keys().next().value;
      if (oldest === undefined) break;
      this.byCall.delete(oldest);
    }
  }

  flags(callId: string): CallOutcomeFlags {
    return { ...(this.byCall.get(callId) ?? { informationProvided: false, policyDeclined: false }) };
  }

  /** Removes the call's flags (call end). */
  take(callId: string): CallOutcomeFlags {
    const f = this.flags(callId);
    this.byCall.delete(callId);
    return f;
  }
}
