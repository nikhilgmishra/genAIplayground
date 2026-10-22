/**
 * Ports of the CallBinding store and issuance service (WP-11; FO-05-16, FO-10-46, FO-01-27; ADR-0018 decision 1.4).
 *
 * The module may import only audit, db, observability, protocol and shared (platform/architecture/modules.yaml,
 * module `calls`), so every collaborator outside that list is a structural port here, implemented by the
 * composition root (platform/src/main, WP-17) or by the gateway media routes (platform/src/gateway/http/media-routes.ts):
 *
 *   ConditionalKv            DynamoDB conditional records (identity/kv DynamoKvStore satisfies it; ADR-0004, ADR-0018 4)
 *   CallSessionPort          the control-plane SessionService behind a trusted carrier integration identity
 *   CarrierInteractionLookup the trusted carrier/media-plane lookup (LiveKit server API) that names the carrier interaction
 *   SessionRefSealer         AES-256-GCM sealing of the bearer session reference (console-api AesGcmTokenSealer satisfies it)
 *   PendingActionInvalidator ActionService.invalidatePending
 *   BindingAuditSink         content-free audit of every binding decision (GatewayAudit through the media routes)
 */
import type { CarrierKind, ConversationAdapter, ProcessingConsent } from "../../protocol/call-binding.js";

/** DynamoDB-shaped conditional store (identity/ports.ts KvStore subset); readers enforce expiry themselves (AUTH-04). */
export interface KvRecord<T> {
  pk: string;
  version: number;
  ttlEpochSeconds: number | null;
  data: T;
}

export interface ConditionalKv {
  readonly kind: "local_fixture" | "live";
  get<T>(pk: string): Promise<KvRecord<T> | null>;
  putIfAbsent<T>(item: KvRecord<T>): Promise<boolean>;
  compareAndSwap<T>(pk: string, expectedVersion: number, data: T, ttlEpochSeconds: number | null): Promise<boolean>;
}

/** The session's consent as the media path needs it (recording and AI-processing dimensions only). */
export interface SessionConsentView {
  recording: ProcessingConsent;
  transcriptionAiProcessing: ProcessingConsent;
  disclosureTemplateVersion: string | null;
}

export interface CallSessionView {
  sessionGeneration: number;
  /** Session expiry; a binding never outlives its session (AUTH-04). */
  expiresAt: string;
  consent: SessionConsentView;
}

/** Control-plane session changes the media lifecycle can cause (each advances the generation). */
export type RuntimeSessionChange = "PARTICIPANT_CHANGED" | "OWNER_RECOVERED";

/**
 * The control-plane SessionService as the binding service uses it. The composition binds it to
 * TrustedSessionService with the trusted carrier integration identity of the media plane (never the runtime's
 * own credential): the bearer session reference never leaves the gateway.
 */
export interface CallSessionPort {
  /** Starts the call's session (A0, generation 1, consent undecided); `callId` is the platform interaction id. */
  start(callId: string): Promise<{ sessionRef: string; sessionGeneration: number; expiresAt: string }>;
  /** Current generation and consent; throws SessionInvalidError when the session is expired, revoked or ended (AUTH-04). */
  view(sessionRef: string, callId: string): Promise<CallSessionView>;
  /** Applies a change: privileges dropped, generation advanced. Returns the new view. */
  change(sessionRef: string, change: RuntimeSessionChange): Promise<CallSessionView>;
  end(sessionRef: string): Promise<void>;
}

/** The carrier interaction of a call as the binding names it. */
export interface CarrierInteraction {
  kind: CarrierKind;
  /** Server-assigned carrier interaction reference (SIP call id of the media plane, or the room's server id). Never the caller number. */
  interactionRef: string;
  /** Trunk or dispatch-rule reference from trusted configuration, or null. */
  routeRef: string | null;
}

/** One SIP party of a room as the media plane lists it (active participants of kind SIP only). */
export interface SipParty {
  /** SHA-256 of the participant identity (a livekit-sip identity can carry the caller number, so it is never kept). */
  partyDigest: string;
  /** The media plane's SIP call id attribute (`sip.callID`); null when absent or not an interaction reference. */
  interactionRef: string | null;
  /** Trunk route reference (`sip-trunk:<trunk id>`), or null. */
  routeRef: string | null;
  /** When the participant joined the room (the media plane's clock, milliseconds). */
  joinedAtMs: number;
}

/**
 * What the media plane's own API states about a room: its server-assigned id (unique per room instance, never
 * reused) and its active SIP parties, earliest joined first. These are facts, not yet a carrier interaction: the
 * binding service pins the room and the carrier party at the first touch and compares them on every later bind
 * (FO-05-16; a holder of the media-plane API secret can mint a SIP-kind participant with any `sip.callID`, so a
 * call id seen in another room never names this room's call).
 */
export interface MediaRoomFacts {
  roomSid: string;
  sipParties: readonly SipParty[];
}

export interface CarrierLookupInput {
  tenantId: string;
  roomName: string;
  jobRef: string;
  agentIdentity: string;
}

/**
 * Trusted lookup (BindingSource `trusted_server_lookup`): confirms with the media plane's own API that the room
 * exists, that the job was dispatched to a worker and is held by the agent participant `agentIdentity`, that this
 * participant is in the room, and returns the room facts. Throws a reason-coded AccessDeniedError when the media
 * plane does not confirm the job, and a DependencyError when it cannot be asked (never a guess).
 */
export interface CarrierInteractionLookup {
  /** Confirms the job and returns the room facts plus the agent participants present in the room now. */
  verify(input: CarrierLookupInput): Promise<MediaRoomFacts & { presentAgents: readonly string[] }>;
  /** Room facts without a job check (session-less human and safety routes, SAFE-02; the supervisor). */
  describeRoom(input: { tenantId: string; roomName: string }): Promise<MediaRoomFacts>;
}

export interface SealedValue {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyId: string;
}

/** AES-256-GCM sealing; `aad` binds a ciphertext to one call record, so a copy onto another record does not open. */
export interface SessionRefSealer {
  readonly currentKeyId: string;
  seal(plaintext: string, aad: string): SealedValue;
  open(sealed: SealedValue, aad: string): string;
}

export interface PendingActionInvalidator {
  invalidatePending(sessionRef: string, reasonCode: string): Promise<number>;
}

export interface BindingAuditEvent {
  action: string;
  outcome: "SUCCEEDED" | "DENIED" | "FAILED";
  tenantId: string;
  interactionId: string | null;
  bindingId: string | null;
  sessionBindingRef: string | null;
  sessionGeneration: number | null;
  reasonCode: string;
  correlationId: string;
}

/** Audit sink; a failure to write is reported to the caller, which fails closed for issuance (OPS-01). */
export interface BindingAuditSink {
  record(event: BindingAuditEvent): Promise<void>;
}

/** Authenticated conversation-runtime identity (the `conversation_runtime` channel, ADR-0018 decision 1.6). */
export interface RuntimeIdentity {
  integrationId: string;
  tenantId: string;
  environment: "local" | "ci" | "sandbox" | "staging" | "production";
  channel: "conversation_runtime";
  credentialId: string;
  authMethod: "oauth2_client_credentials";
  /** Conversation adapters this credential may own calls as. */
  adapters: readonly ConversationAdapter[];
}
