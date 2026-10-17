/**
 * LOCAL FIXTURE — TelephonyControl (Talkdesk-like) with simulated transfer
 * lifecycle events. NOT Talkdesk and NOT sandbox evidence; rejected by the
 * production configuration guard (OPS-04). The live adapter is BLOCKED
 * (live/talkdesk-blocked.ts: PRQ-004, PRQ-019 / TB-07, PRQ-021 / TB-09).
 *
 * SAFE-05: `requestTransfer` accepts ONLY destination ids present in the
 * trusted allowlist passed at construction (from DestinationConfig). Anything
 * else — a phone number, a tel:/sip: URI, a URL, an unknown dst_ id, a value a
 * caller, model, tool result or retrieved document proposed — is rejected with
 * AccessDeniedError DESTINATION_NOT_ALLOWLISTED and nothing is dialled. The
 * rejected value itself is never stored or logged.
 *
 * SAFE-04: a successful `requestTransfer` is only REQUESTED. The fixture then
 * emits lifecycle events REQUESTED -> QUEUED -> RECEIVER_ACCEPTED -> BRIDGED ->
 * CALLER_CONFIRMED_CONNECTED (optionally COMPLETED) to subscribers, or a
 * scripted failure: RECEIVER_UNAVAILABLE, TIMED_OUT, BRIDGE_DROPPED,
 * CALLER_DISCONNECTED, or STALLED (no further events: the coordinator must time
 * out on its own). Delivery can duplicate events and permute their order
 * (scripted, or via the DUPLICATE_DELIVERY / OUT_OF_ORDER faults), and an event
 * a subscriber fails to process is redelivered (at-least-once, like a vendor
 * webhook). Consumers must deduplicate by `eventId` and order by `sequence`.
 *
 * Delivery is explicit (`deliverNext` / `deliverAll`) so tests are
 * deterministic. `playApprovedUpdate` records TEMPLATE IDS only — the fixture
 * never receives or stores caller-facing text. There is no hang-up operation.
 */
import { z } from "zod";
import { silentLogger } from "../../observability/logger.js";
import type { Logger } from "../../observability/ports.js";
import { DestinationId, OpaqueId, type TransferState } from "../../protocol/index.js";
import { iso, systemClock, type Clock } from "../../shared/clock.js";
import { AccessDeniedError, PlatformError, ValidationError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import type { AdapterHealth, TelephonyControl } from "../ports.js";
import { noFaults, type FaultInjector } from "./faults.js";
import { LOCAL_FIXTURE_LABEL } from "./synthetic-store.js";

const TEMPLATE_ID = /^[a-z][a-z0-9_.]{2,63}$/;
const VENDOR_QUEUE_REF = /^[A-Za-z0-9_:.-]{3,128}$/;

/** True for anything that could be dialled or fetched directly: phone numbers, tel/sip URIs, URLs, e-mail addresses. */
export function looksLikeDialTarget(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const digits = (value.match(/\d/g) ?? []).length;
  return (
    /^\s*\+/.test(value) ||
    digits >= 7 ||
    /\b(tel|sip|sips|callto|https?|wss?|ftp)\s*:/i.test(value) ||
    value.includes("@") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

export interface TrustedTransferDestination {
  destinationId: string;
  vendorQueueRef: string;
  purpose?: string;
}

export type ProgressState = "REQUESTED" | "QUEUED" | "RECEIVER_ACCEPTED" | "BRIDGED" | "CALLER_CONFIRMED_CONNECTED";

export type TransferScript =
  | { outcome: "CONNECTED"; complete?: boolean }
  | { outcome: "RECEIVER_UNAVAILABLE" }
  | { outcome: "TIMED_OUT"; after: Exclude<ProgressState, "CALLER_CONFIRMED_CONNECTED"> }
  | { outcome: "BRIDGE_DROPPED"; after?: "RECEIVER_ACCEPTED" | "BRIDGED" | "CALLER_CONFIRMED_CONNECTED" }
  | { outcome: "CALLER_DISCONNECTED"; after: ProgressState }
  | { outcome: "STALLED"; after: Exclude<ProgressState, "CALLER_CONFIRMED_CONNECTED"> };

export interface DeliveryScript {
  /** Each event is delivered twice (the copy arrives after the next original). */
  duplicate?: boolean;
  /** Adjacent events after REQUESTED are swapped pairwise. */
  outOfOrder?: boolean;
}

export interface TelephonyEvent {
  /** Stable per logical event; duplicates and redeliveries share it. */
  eventId: string;
  /** Logical order within the transfer (1 = REQUESTED). */
  sequence: number;
  transferRef: string;
  callId: string;
  handoffId: string;
  destinationId: string;
  state: TransferState;
  occurredAt: string;
  /** Delivery metadata (LOCAL FIXTURE only). */
  delivery: { index: number; duplicate: boolean; redelivery: boolean };
}

/** How the workflow TransferCoordinator names each lifecycle state (platform/src/workflows/transfer.ts). */
export const TRANSFER_EVENT_FOR_STATE: Readonly<Partial<Record<TransferState, string>>> = {
  QUEUED: "QUEUED",
  RECEIVER_ACCEPTED: "RECEIVER_ACCEPTED",
  BRIDGED: "BRIDGED",
  CALLER_CONFIRMED_CONNECTED: "CALLER_CONFIRMED_CONNECTED",
  COMPLETED: "COMPLETE",
  TIMED_OUT: "TIMEOUT",
  RECEIVER_UNAVAILABLE: "RECEIVER_UNAVAILABLE",
  BRIDGE_DROPPED: "BRIDGE_DROPPED",
  CALLER_DISCONNECTED: "CALLER_DISCONNECTED",
};

export interface DialRecord {
  transferRef: string;
  callId: string;
  destinationId: string;
  vendorQueueRef: string;
  handoffId: string;
  priority: "SAFETY" | "STANDARD";
  at: string;
}

export interface RejectedTransferRequest {
  reasonCode: string;
  /** Whether the rejected destination looked like a phone number / URI (the value itself is never kept). */
  looksLikeDialTarget: boolean;
  at: string;
}

export interface TelephonyFixtureOptions {
  /** Trusted allowlist from configuration. The ONLY targets that can ever be dialled. */
  destinations: readonly TrustedTransferDestination[];
  /** When given, playApprovedUpdate accepts only these template ids. */
  approvedTemplateIds?: readonly string[];
  /** Script for transfers without a destination or one-shot script. Default CONNECTED. */
  defaultScript?: TransferScript;
  faults?: FaultInjector;
  clock?: Clock;
  logger?: Logger;
  /** Redeliveries of an event a subscriber failed to process (default 3). */
  maxRedeliveries?: number;
}

export const TELEPHONY_FIXTURE_OPERATIONS = {
  requestTransfer: ["OUTAGE", "TIMEOUT_BEFORE_SEND", "TIMEOUT_AFTER_COMMIT", "SLOW", "QUOTA_EXHAUSTED", "REJECTED", "DUPLICATE_DELIVERY", "OUT_OF_ORDER"],
  playApprovedUpdate: ["OUTAGE", "TIMEOUT_BEFORE_SEND", "TIMEOUT_AFTER_COMMIT", "SLOW", "QUOTA_EXHAUSTED", "REJECTED"],
} as const;

const RequestInput = z.strictObject({
  callId: OpaqueId,
  destinationId: z.unknown(),
  handoffId: OpaqueId,
  priority: z.enum(["SAFETY", "STANDARD"]),
});
const UpdateInput = z.strictObject({ callId: OpaqueId, templateId: z.string().regex(TEMPLATE_ID) });

type Subscriber = (event: TelephonyEvent) => void | Promise<void>;

interface QueuedEvent {
  event: Omit<TelephonyEvent, "delivery">;
  duplicate: boolean;
  redelivery: boolean;
}

const PROGRESS: readonly ProgressState[] = ["REQUESTED", "QUEUED", "RECEIVER_ACCEPTED", "BRIDGED", "CALLER_CONFIRMED_CONNECTED"];
const upTo = (s: ProgressState): TransferState[] => PROGRESS.slice(0, PROGRESS.indexOf(s) + 1);

/** The vendor-side state sequence a script produces, in logical order. */
export function statesForScript(script: TransferScript): TransferState[] {
  switch (script.outcome) {
    case "CONNECTED":
      return script.complete ? [...PROGRESS, "COMPLETED"] : [...PROGRESS];
    case "RECEIVER_UNAVAILABLE":
      return ["REQUESTED", "QUEUED", "RECEIVER_UNAVAILABLE"];
    case "TIMED_OUT":
      return [...upTo(script.after), "TIMED_OUT"];
    case "BRIDGE_DROPPED":
      return [...upTo(script.after ?? "BRIDGED"), "BRIDGE_DROPPED"];
    case "CALLER_DISCONNECTED":
      return [...upTo(script.after), "CALLER_DISCONNECTED"];
    case "STALLED":
      return upTo(script.after);
  }
}

/** Deterministic delivery order: optional pairwise swap after REQUESTED, optional late duplicates. */
export function deliveryOrder<T>(events: readonly T[], d: DeliveryScript): { item: T; duplicate: boolean }[] {
  const ordered = [...events];
  if (d.outOfOrder) {
    for (let i = 1; i + 1 < ordered.length; i += 2) {
      const a = ordered[i] as T;
      ordered[i] = ordered[i + 1] as T;
      ordered[i + 1] = a;
    }
  }
  if (!d.duplicate) return ordered.map((item) => ({ item, duplicate: false }));
  const out: { item: T; duplicate: boolean }[] = [];
  ordered.forEach((item, i) => {
    out.push({ item, duplicate: false });
    if (i > 0) out.push({ item: ordered[i - 1] as T, duplicate: true });
  });
  const last = ordered[ordered.length - 1];
  if (last !== undefined) out.push({ item: last, duplicate: true });
  return out;
}

export class TelephonyFixture implements TelephonyControl {
  readonly kind = "local_fixture" as const;
  readonly integrationId = "talkdesk-telephony";
  readonly label = LOCAL_FIXTURE_LABEL;
  private readonly allowlist: ReadonlyMap<string, TrustedTransferDestination>;
  private readonly approvedTemplates: ReadonlySet<string> | null;
  private readonly defaultScript: TransferScript;
  private readonly faults: FaultInjector;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly maxRedeliveries: number;
  private readonly subscribers = new Set<Subscriber>();
  private readonly queue: QueuedEvent[] = [];
  private readonly destinationScripts = new Map<string, { script: TransferScript; delivery: DeliveryScript }>();
  private readonly nextScripts: { script: TransferScript; delivery: DeliveryScript }[] = [];
  private readonly dialLog: DialRecord[] = [];
  private readonly updateLog: { callId: string; templateId: string; at: string }[] = [];
  private readonly rejectedLog: RejectedTransferRequest[] = [];
  private readonly deliveredLog: TelephonyEvent[] = [];
  private readonly deliveryFailureLog: { eventId: string; reasonCode: string }[] = [];
  private readonly redeliveries = new Map<string, number>();
  private readonly eventsByTransfer = new Map<string, Omit<TelephonyEvent, "delivery">[]>();
  private deliveryIndex = 0;

  constructor(opts: TelephonyFixtureOptions) {
    if (opts.destinations.length === 0) throw new ValidationError("TELEPHONY_ALLOWLIST_EMPTY");
    const map = new Map<string, TrustedTransferDestination>();
    for (const d of opts.destinations) {
      if (!DestinationId.safeParse(d.destinationId).success || looksLikeDialTarget(d.destinationId)) throw new ValidationError("TELEPHONY_ALLOWLIST_INVALID");
      if (!VENDOR_QUEUE_REF.test(d.vendorQueueRef) || looksLikeDialTarget(d.vendorQueueRef)) throw new ValidationError("TELEPHONY_ALLOWLIST_INVALID");
      if (map.has(d.destinationId)) throw new ValidationError("TELEPHONY_ALLOWLIST_DUPLICATE");
      map.set(d.destinationId, { ...d });
    }
    this.allowlist = map;
    if (opts.approvedTemplateIds) {
      if (opts.approvedTemplateIds.some((t) => !TEMPLATE_ID.test(t))) throw new ValidationError("TELEPHONY_TEMPLATE_ALLOWLIST_INVALID");
      this.approvedTemplates = new Set(opts.approvedTemplateIds);
    } else {
      this.approvedTemplates = null;
    }
    this.defaultScript = opts.defaultScript ?? { outcome: "CONNECTED" };
    this.faults = opts.faults ?? noFaults();
    this.clock = opts.clock ?? systemClock;
    this.logger = (opts.logger ?? silentLogger).child({ component: "telephony_fixture" });
    this.maxRedeliveries = opts.maxRedeliveries ?? 3;
    this.faults.declare(this.integrationId, TELEPHONY_FIXTURE_OPERATIONS);
  }

  async health(): Promise<AdapterHealth> {
    return this.faults.isDegraded(this.integrationId) ? { healthy: false, reasonCode: "DEPENDENCY_UNAVAILABLE" } : { healthy: true, reasonCode: null };
  }

  async requestTransfer(input: { callId: string; destinationId: string; handoffId: string; priority: "SAFETY" | "STANDARD" }): Promise<{ transferRef: string }> {
    const parsed = RequestInput.safeParse(input);
    if (!parsed.success) {
      this.reject("TRANSFER_INPUT_INVALID", (input as { destinationId?: unknown } | null)?.destinationId);
      throw new ValidationError("TRANSFER_INPUT_INVALID");
    }
    const { callId, handoffId, priority } = parsed.data;
    const rawDestination = parsed.data.destinationId;
    const destination = typeof rawDestination === "string" && DestinationId.safeParse(rawDestination).success ? this.allowlist.get(rawDestination) : undefined;
    if (!destination) {
      this.reject("DESTINATION_NOT_ALLOWLISTED", rawDestination);
      throw new AccessDeniedError("DESTINATION_NOT_ALLOWLISTED");
    }

    const f = this.faults.begin(this.integrationId, "requestTransfer");
    await f.beforeSend();

    const scripted = this.nextScripts.shift() ?? this.destinationScripts.get(destination.destinationId) ?? { script: this.defaultScript, delivery: {} };
    const delivery: DeliveryScript = {
      duplicate: scripted.delivery.duplicate === true || f.has("DUPLICATE_DELIVERY"),
      outOfOrder: scripted.delivery.outOfOrder === true || f.has("OUT_OF_ORDER"),
    };
    const transferRef = newId("tdx");
    const at = iso(this.clock.now());
    this.dialLog.push({ transferRef, callId, destinationId: destination.destinationId, vendorQueueRef: destination.vendorQueueRef, handoffId, priority, at });
    const events = statesForScript(scripted.script).map((state, i) => ({
      eventId: `${transferRef}:${i + 1}`,
      sequence: i + 1,
      transferRef,
      callId,
      handoffId,
      destinationId: destination.destinationId,
      state,
      occurredAt: at,
    }));
    this.eventsByTransfer.set(transferRef, events);
    for (const { item, duplicate } of deliveryOrder(events, delivery)) this.queue.push({ event: item, duplicate, redelivery: false });
    this.logger.info("fixture.telephony.transfer.requested", { transferRef, destinationId: destination.destinationId, priority });

    f.afterCommit(); // TIMEOUT_AFTER_COMMIT: the transfer exists although the caller saw a timeout
    return { transferRef };
  }

  async playApprovedUpdate(input: { callId: string; templateId: string }): Promise<void> {
    const parsed = UpdateInput.safeParse(input);
    if (!parsed.success) throw new ValidationError("APPROVED_UPDATE_INPUT_INVALID");
    if (this.approvedTemplates && !this.approvedTemplates.has(parsed.data.templateId)) throw new ValidationError("TEMPLATE_NOT_APPROVED");
    const f = this.faults.begin(this.integrationId, "playApprovedUpdate");
    await f.beforeSend();
    this.updateLog.push({ callId: parsed.data.callId, templateId: parsed.data.templateId, at: iso(this.clock.now()) });
    f.afterCommit();
  }

  // ---------------- event subscription and delivery ----------------

  subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /** Delivers the next queued event to every subscriber; returns it, or null when the queue is empty. */
  async deliverNext(): Promise<TelephonyEvent | null> {
    const q = this.queue.shift();
    if (!q) return null;
    const event: TelephonyEvent = { ...q.event, delivery: { index: ++this.deliveryIndex, duplicate: q.duplicate, redelivery: q.redelivery } };
    this.deliveredLog.push(event);
    let failed = false;
    for (const s of [...this.subscribers]) {
      try {
        await s(structuredClone(event));
      } catch (err) {
        failed = true;
        this.deliveryFailureLog.push({ eventId: event.eventId, reasonCode: err instanceof PlatformError ? err.reasonCode : "SUBSCRIBER_ERROR" });
      }
    }
    if (failed) {
      const n = this.redeliveries.get(event.eventId) ?? 0;
      if (n < this.maxRedeliveries) {
        this.redeliveries.set(event.eventId, n + 1);
        this.queue.push({ event: q.event, duplicate: q.duplicate, redelivery: true });
      }
    }
    return event;
  }

  /** Delivers until the queue is empty (bounded). Returns the number of deliveries. */
  async deliverAll(maxDeliveries = 10_000): Promise<number> {
    let n = 0;
    while (n < maxDeliveries && (await this.deliverNext())) n += 1;
    return n;
  }

  // ---------------- LOCAL FIXTURE scripting and inspection ----------------

  /** Outcome for the next transfer request (FIFO, one-shot); takes precedence over destination scripts. */
  scriptNextTransfer(script: TransferScript, delivery: DeliveryScript = {}): void {
    this.nextScripts.push({ script, delivery });
  }

  /** Outcome for every transfer to a destination until replaced. */
  scriptDestination(destinationId: string, script: TransferScript, delivery: DeliveryScript = {}): void {
    if (!this.allowlist.has(destinationId)) throw new ValidationError("DESTINATION_NOT_ALLOWLISTED");
    this.destinationScripts.set(destinationId, { script, delivery });
  }

  /** The caller hangs up mid-transfer: undelivered progress events are dropped and CALLER_DISCONNECTED is queued. */
  simulateCallerDisconnect(transferRef: string): void {
    const events = this.eventsByTransfer.get(transferRef);
    if (!events) throw new ValidationError("TRANSFER_NOT_FOUND");
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]?.event.transferRef === transferRef) this.queue.splice(i, 1);
    const last = events[events.length - 1];
    if (!last) throw new ValidationError("TRANSFER_NOT_FOUND");
    const sequence = last.sequence + 1;
    const ev = { ...last, eventId: `${transferRef}:${sequence}`, sequence, state: "CALLER_DISCONNECTED" as const, occurredAt: iso(this.clock.now()) };
    events.push(ev);
    this.queue.push({ event: ev, duplicate: false, redelivery: false });
  }

  get dials(): readonly DialRecord[] {
    return this.dialLog.map((d) => ({ ...d }));
  }

  get updates(): readonly { callId: string; templateId: string; at: string }[] {
    return this.updateLog.map((u) => ({ ...u }));
  }

  get rejections(): readonly RejectedTransferRequest[] {
    return this.rejectedLog.map((r) => ({ ...r }));
  }

  get delivered(): readonly TelephonyEvent[] {
    return this.deliveredLog.map((e) => structuredClone(e));
  }

  get deliveryFailures(): readonly { eventId: string; reasonCode: string }[] {
    return this.deliveryFailureLog.map((f) => ({ ...f }));
  }

  get pendingEvents(): number {
    return this.queue.length;
  }

  /** Vendor-side truth: the last state in logical order for a transfer (null if unknown). */
  vendorState(transferRef: string): TransferState | null {
    const events = this.eventsByTransfer.get(transferRef);
    return events?.[events.length - 1]?.state ?? null;
  }

  private reject(reasonCode: string, destination: unknown): void {
    this.rejectedLog.push({ reasonCode, looksLikeDialTarget: looksLikeDialTarget(destination), at: iso(this.clock.now()) });
    this.logger.warn("fixture.telephony.transfer.rejected", { reasonCode });
  }
}
