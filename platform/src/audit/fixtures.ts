/**
 * LOCAL TEST FIXTURES for the audit module, for use in other modules' tests.
 * None of these provide durable or independent evidence; production
 * configuration must never wire them (OPS-04).
 */
import type { Queryable } from "../db/types.js";
import type { AuditEvent, AuditEventInput, AuditManifest } from "../protocol/index.js";
import { AuditUnavailableError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { buildChainedEvent } from "./chain.js";
import type { AuditHealth, AuditHealthStatus, AuditSink, AuditWriter } from "./ports.js";
import { assertStreamName, normalizeAuditInput, validateAuditInput } from "./schema.js";
import { AuditSinkError } from "./sinks/common.js";

export const AUDIT_FIXTURE_BADGE = "LOCAL AUDIT FIXTURE — NOT DURABLE, NOT INDEPENDENT EVIDENCE";

/**
 * LOCAL FIXTURE: in-memory writer with the same validation, normalization and
 * hash chaining as PgAuditWriter. It cannot join a caller's database transaction
 * (events are kept even if the caller rolls back), so it must not be used to
 * demonstrate OPS-01 atomicity; use PgAuditWriter over PGlite for that.
 */
export class InMemoryAuditWriterFixture implements AuditWriter {
  readonly kind = "local_fixture" as const;
  readonly badge = AUDIT_FIXTURE_BADGE;
  private readonly heads = new Map<string, { sequence: number; hash: string | null }>();
  readonly events: AuditEvent[] = [];

  constructor(private readonly defaultStream = "fixture.memory") {
    assertStreamName(defaultStream);
  }

  async append(_tx: Queryable, input: AuditEventInput, stream?: string): Promise<AuditEvent> {
    return this.appendStandalone(input, stream);
  }

  async appendStandalone(input: AuditEventInput, stream?: string): Promise<AuditEvent> {
    const valid = normalizeAuditInput(validateAuditInput(input));
    const s = assertStreamName(stream ?? this.defaultStream);
    const head = this.heads.get(s) ?? { sequence: 0, hash: null };
    const event = buildChainedEvent(valid, newId("aud"), { sourceStream: s, sequence: head.sequence + 1, prevHash: head.hash });
    this.heads.set(s, { sequence: event.sequence, hash: event.hash });
    this.events.push(event);
    return event;
  }

  byAction(action: string): AuditEvent[] {
    return this.events.filter((e) => e.action === action);
  }
}

/**
 * LOCAL FIXTURE: wraps a writer and simulates an audit outage. While the outage
 * is on, every append throws AuditUnavailableError, so callers can prove they
 * fail closed (OPS-01) and roll back their own transaction.
 */
export class AuditWriterOutageFixture implements AuditWriter {
  readonly kind = "local_fixture" as const;
  readonly badge = AUDIT_FIXTURE_BADGE;
  private outageReason: string | null = null;
  attemptsDuringOutage = 0;

  constructor(private readonly inner: AuditWriter = new InMemoryAuditWriterFixture()) {}

  setOutage(on: boolean, reasonCode = "AUDIT_STORE_UNWRITABLE"): void {
    this.outageReason = on ? reasonCode : null;
  }

  get outage(): boolean {
    return this.outageReason !== null;
  }

  async append(tx: Queryable, input: AuditEventInput, stream?: string): Promise<AuditEvent> {
    this.guard();
    return this.inner.append(tx, input, stream);
  }

  async appendStandalone(input: AuditEventInput, stream?: string): Promise<AuditEvent> {
    this.guard();
    return this.inner.appendStandalone(input, stream);
  }

  private guard(): void {
    if (this.outageReason !== null) {
      this.attemptsDuringOutage += 1;
      throw new AuditUnavailableError(this.outageReason);
    }
  }
}

/** LOCAL FIXTURE: AuditHealth with a settable status. */
export class StaticAuditHealthFixture implements AuditHealth {
  readonly kind = "local_fixture" as const;
  private current: AuditHealthStatus = {
    canAcceptConsequential: true,
    backlogCount: 0,
    oldestUnshippedAgeSeconds: null,
    sinkHealthy: true,
    reasonCode: null,
  };

  setBlocked(reasonCode: "AUDIT_BACKLOG_EXCEEDED" | "AUDIT_STORE_UNWRITABLE" | "AUDIT_SINK_STALE"): void {
    this.current = { ...this.current, canAcceptConsequential: false, sinkHealthy: reasonCode !== "AUDIT_SINK_STALE", reasonCode };
  }

  setHealthy(): void {
    this.current = { canAcceptConsequential: true, backlogCount: 0, oldestUnshippedAgeSeconds: null, sinkHealthy: true, reasonCode: null };
  }

  async status(): Promise<AuditHealthStatus> {
    return { ...this.current };
  }

  async assertCanAcceptConsequential(): Promise<void> {
    if (!this.current.canAcceptConsequential) throw new AuditUnavailableError(this.current.reasonCode ?? "AUDIT_UNAVAILABLE");
  }
}

/**
 * LOCAL FIXTURE: sink wrapper with fault injection.
 *   - failPuts(n): the next n putBatch calls fail before reaching the inner sink (sink outage)
 *   - crashAfterPut(n): the next n putBatch calls reach the inner sink and THEN fail,
 *     simulating a lost response or a process crash between put and mark
 */
export class FaultInjectingAuditSinkFixture implements AuditSink {
  readonly kind = "local_fixture" as const;
  private failBefore = 0;
  private failAfter = 0;
  putAttempts = 0;

  constructor(private readonly inner: AuditSink) {}

  failPuts(n: number): void {
    this.failBefore = n;
  }

  crashAfterPut(n: number): void {
    this.failAfter = n;
  }

  async putBatch(manifest: AuditManifest, eventsNdjson: string): Promise<void> {
    this.putAttempts += 1;
    if (this.failBefore > 0) {
      this.failBefore -= 1;
      throw new AuditSinkError("AUDIT_SINK_UNAVAILABLE", true);
    }
    await this.inner.putBatch(manifest, eventsNdjson);
    if (this.failAfter > 0) {
      this.failAfter -= 1;
      throw new AuditSinkError("AUDIT_SINK_RESPONSE_LOST", true);
    }
  }

  listManifests(stream: string): Promise<AuditManifest[]> {
    return this.inner.listManifests(stream);
  }

  getBatch(objectKey: string): Promise<string> {
    return this.inner.getBatch(objectKey);
  }
}

/** Convenience for tests: an in-memory writer plus an outage toggle wrapping it. */
export function createAuditFixtures(): { memory: InMemoryAuditWriterFixture; writer: AuditWriterOutageFixture } {
  const memory = new InMemoryAuditWriterFixture();
  return { memory, writer: new AuditWriterOutageFixture(memory) };
}
