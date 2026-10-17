/**
 * LOCAL TEST FIXTURE — fake system of record implementing ProviderCommitPort. SYNTHETIC only;
 * not a vendor adapter and never acceptable in production (OPS-04).
 *
 * Keeps an effects log keyed by provider idempotency key so tests can prove "exactly one
 * effect" (ACT-02), and injects the failure modes the commit protocol must survive:
 *   timeout_before_send       -> DependencyError NOT_STARTED, nothing applied
 *   timeout_after_commit      -> effect applied, then DependencyError UNKNOWN (ambiguous timeout)
 *   crash_after_commit        -> effect applied, `onCrash` runs, then a non-dependency error
 *   permanent_failure         -> FAILED (permanent), nothing applied
 *   version_conflict_on_commit-> a concurrent writer changes the record just before apply
 * plus a concurrent version change before the ledger's optimistic-concurrency check, and
 * lookup faults (UNKNOWN / throw).
 */
import type { PreparedAction } from "../../protocol/index.js";
import { DependencyError } from "../../shared/errors.js";
import type { ProviderCommitPort, ProviderCommitResult, ProviderLookupResult } from "../ports.js";

export const FAKE_PROVIDER_FIXTURE_BADGE = "LOCAL FIXTURE — fake system of record, synthetic data only";

export type CommitFault = "timeout_before_send" | "timeout_after_commit" | "crash_after_commit" | "permanent_failure" | "version_conflict_on_commit";
export type LookupFault = "unknown" | "throw";

/** Non-dependency error simulating process death after the provider applied the effect. */
export class SimulatedCrashFixtureError extends Error {
  constructor() {
    super("SIMULATED_CRASH_FIXTURE");
    this.name = "SimulatedCrashFixtureError";
  }
}

export interface FakeEffect {
  idempotencyKey: string;
  actionId: string;
  recordKey: string;
  providerReference: string;
  beforeVersion: string;
  afterVersion: string;
  sequence: number;
}

export class FakeProviderFixture implements ProviderCommitPort {
  readonly kind = "local_fixture" as const;
  readonly badge = FAKE_PROVIDER_FIXTURE_BADGE;
  /** Every applied effect, in order. A duplicate application would appear twice. */
  readonly effects: FakeEffect[] = [];
  readonly calls = { commit: 0, lookup: 0, currentVersion: 0 };
  /** Provider keys passed to commit(), in order. */
  readonly commitKeys: string[] = [];
  /** commit() calls received after an effect for the same action already existed (must stay 0). */
  redundantCommitCalls = 0;
  /** Runs right before a crash_after_commit fault throws (e.g. to arm a crashing Db fixture). */
  onCrash: (() => void) | undefined;
  /** When set, commit() awaits it before applying (to hold a commit in flight). */
  gate: Promise<void> | undefined;

  private readonly byKey = new Map<string, FakeEffect>();
  private readonly versions = new Map<string, number>();
  private readonly commitFaults: CommitFault[] = [];
  private readonly lookupFaults: LookupFault[] = [];
  private pendingVersionChanges = 0;
  private sequence = 0;
  private readonly dedupByKey: boolean;

  /** `providerDedupByKey: false` disables provider-side idempotency so only the ledger prevents duplicates. */
  constructor(opts: { providerDedupByKey?: boolean } = {}) {
    this.dedupByKey = opts.providerDedupByKey ?? true;
  }

  static recordKey(system: string, recordRef: string): string {
    return `${system}:${recordRef}`;
  }

  seedRecord(system: string, recordRef: string, version = 1): void {
    this.versions.set(FakeProviderFixture.recordKey(system, recordRef), version);
  }

  versionOf(system: string, recordRef: string): string {
    const v = this.versions.get(FakeProviderFixture.recordKey(system, recordRef));
    return `v${v ?? 0}`;
  }

  /** Another writer changes the record outside the ledger (e.g. staff edit in the source system). */
  changeExternally(system: string, recordRef: string): void {
    const k = FakeProviderFixture.recordKey(system, recordRef);
    this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
  }

  injectCommitFault(...faults: CommitFault[]): void {
    this.commitFaults.push(...faults);
  }

  injectLookupFault(...faults: LookupFault[]): void {
    this.lookupFaults.push(...faults);
  }

  /** The next currentVersion() observes a concurrent change made just before it reads. */
  injectConcurrentVersionChange(): void {
    this.pendingVersionChanges += 1;
  }

  clearFaults(): void {
    this.commitFaults.length = 0;
    this.lookupFaults.length = 0;
    this.pendingVersionChanges = 0;
  }

  effectsFor(actionId: string): number {
    return this.effects.filter((e) => e.actionId === actionId).length;
  }

  async currentVersion(action: PreparedAction): Promise<string> {
    this.calls.currentVersion += 1;
    const k = FakeProviderFixture.recordKey(action.target.system, action.target.recordRef);
    if (!this.versions.has(k)) throw new Error("FIXTURE_RECORD_UNKNOWN");
    if (this.pendingVersionChanges > 0) {
      this.pendingVersionChanges -= 1;
      this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
    }
    return `v${this.versions.get(k)}`;
  }

  async commit(action: PreparedAction, providerIdempotencyKey: string): Promise<ProviderCommitResult> {
    this.calls.commit += 1;
    this.commitKeys.push(providerIdempotencyKey);
    if (this.effectsFor(action.actionId) > 0) this.redundantCommitCalls += 1;
    if (this.gate) await this.gate;
    const fault = this.commitFaults.shift();
    if (fault === "timeout_before_send") throw new DependencyError("FIXTURE_TIMEOUT_BEFORE_SEND", "NOT_STARTED");
    const existing = this.byKey.get(providerIdempotencyKey);
    if (this.dedupByKey && existing) return this.committed(existing);
    if (fault === "permanent_failure") return { outcome: "FAILED", reasonCode: "FIXTURE_PERMANENT_REJECTION", permanent: true };
    const k = FakeProviderFixture.recordKey(action.target.system, action.target.recordRef);
    if (!this.versions.has(k)) return { outcome: "FAILED", reasonCode: "FIXTURE_RECORD_UNKNOWN", permanent: true };
    if (fault === "version_conflict_on_commit") this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
    const current = `v${this.versions.get(k)}`;
    if (current !== action.target.beforeVersion) return { outcome: "FAILED", reasonCode: "VERSION_CONFLICT", permanent: true };
    const next = (this.versions.get(k) ?? 0) + 1;
    this.versions.set(k, next);
    this.sequence += 1;
    const effect: FakeEffect = {
      idempotencyKey: providerIdempotencyKey,
      actionId: action.actionId,
      recordKey: k,
      providerReference: `fxref_${String(this.sequence).padStart(16, "0")}`,
      beforeVersion: action.target.beforeVersion,
      afterVersion: `v${next}`,
      sequence: this.sequence,
    };
    this.effects.push(effect);
    this.byKey.set(providerIdempotencyKey, effect);
    if (fault === "timeout_after_commit") throw new DependencyError("FIXTURE_TIMEOUT_AFTER_SEND", "UNKNOWN");
    if (fault === "crash_after_commit") {
      this.onCrash?.();
      throw new SimulatedCrashFixtureError();
    }
    return this.committed(effect);
  }

  async lookup(_action: PreparedAction, providerIdempotencyKey: string): Promise<ProviderLookupResult> {
    this.calls.lookup += 1;
    const fault = this.lookupFaults.shift();
    if (fault === "unknown") return { outcome: "UNKNOWN" };
    if (fault === "throw") throw new DependencyError("FIXTURE_LOOKUP_TIMEOUT", "UNKNOWN");
    const e = this.byKey.get(providerIdempotencyKey);
    return e ? this.committed(e) : { outcome: "NOT_FOUND" };
  }

  private committed(e: FakeEffect): Extract<ProviderCommitResult, { outcome: "COMMITTED" }> {
    return {
      outcome: "COMMITTED",
      providerReference: e.providerReference,
      afterVersion: e.afterVersion,
      evidence: { providerReference: e.providerReference, afterVersion: e.afterVersion, fixture: true },
    };
  }
}
