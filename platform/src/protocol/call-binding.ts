/**
 * CallBinding (follow-on prompt sections 4 and 5; ADR-0018 decision 1.4, TB-01).
 *
 * Binds one trusted carrier interaction to the platform interaction, the session generation and
 * the single conversation owner that holds the call-owner lease. It is produced only by the
 * trusted dispatch rule or carrier adapter (never from a model argument or a caller-supplied call
 * id) and is checked by the gateway on every tool call and speech request.
 *
 * Created by WP-02 in phase B; owned by WP-11 from phase C (store and issuance in
 * platform/src/calls/binding, worker side in media/src/binding).
 */
import { z } from "zod";
import { ENVELOPE_FIELDS, OpaqueId, envelope, isAfter, opaqueIdWithPrefix } from "./common.js";

export const CALL_BINDING_SCHEMA_VERSION = "call-binding.v1";

/** Carrier or media path that delivered the call. */
export const CarrierKind = z.enum(["talkdesk", "sip_reference", "livekit_webrtc", "local_softphone"]);
export type CarrierKind = z.infer<typeof CarrierKind>;

/** Conversation adapter that owns the call (exactly one at a time, ADR-0018 decision 1.4). */
export const ConversationAdapter = z.enum(["controlled_cascade_runtime", "native_duplex_runtime", "talkdesk_ai_agent_mcp", "human_only"]);
export type ConversationAdapter = z.infer<typeof ConversationAdapter>;

/** Phone-number shaped strings (E.164 or plain digit runs with separators) are never identifiers. */
const PHONE_SHAPED = /^\+?[0-9 ().-]{7,24}$/;
/** A party address (tel:, sip:, sips: URI) names a caller or callee, never an interaction. */
const PARTY_URI = /^(?:tel|sips?):/i;

/**
 * The carrier's own interaction identifier (vendor id, SIP Call-ID token). Opaque to the platform;
 * a value shaped like a phone number, or a tel:/sip:/sips: party URI (which would carry the ANI in
 * its user part), is refused so caller ANI can never become the binding key.
 */
export const CarrierInteractionRef = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "carrier interaction reference expected")
  .refine((v) => !PHONE_SHAPED.test(v), "phone-number shaped value is not an interaction reference")
  .refine((v) => !PARTY_URI.test(v), "a tel:/sip:/sips: party URI is not an interaction reference");
export type CarrierInteractionRef = z.infer<typeof CarrierInteractionRef>;

/** Non-bearer session binding reference (`ses_bnd_` + base64url sha256 of the bearer), see actions/digest.ts. */
export const SessionBindingRef = z.string().regex(/^ses_bnd_[A-Za-z0-9_-]{43}$/, "session binding reference expected");

/** How the binding was established. A model, a caller utterance or a tool argument is never a source. */
export const BindingSource = z.enum(["carrier_dispatch_rule", "carrier_webhook_verified", "trusted_server_lookup"]);
export type BindingSource = z.infer<typeof BindingSource>;

export const CallBindingState = z.enum(["ACTIVE", "SUPERSEDED", "ENDED", "REVOKED"]);
export type CallBindingState = z.infer<typeof CallBindingState>;

export const CallBinding = z
  .strictObject({
    ...envelope(CALL_BINDING_SCHEMA_VERSION, ["tenantId", "interactionId", "sessionGeneration", "occurredAt", "expiresAt"], ["causationId"]),
    bindingId: opaqueIdWithPrefix("cbd"),
    carrier: z.strictObject({
      kind: CarrierKind,
      interactionRef: CarrierInteractionRef,
      /** Trunk, dispatch rule or Studio flow reference from trusted configuration (never a dial string). */
      routeRef: z.string().regex(/^[A-Za-z0-9_:./-]{3,128}$/).nullable(),
    }),
    owner: z.strictObject({
      adapter: ConversationAdapter,
      /** Worker or replica instance holding the call-owner lease. */
      instanceRef: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
      /** Monotonic fencing token of the call-owner lease; a stale token is refused. */
      fencingToken: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    }),
    /** Session the interaction is bound to, as a non-bearer reference; null before verification. */
    sessionBindingRef: SessionBindingRef.nullable(),
    boundBy: BindingSource,
    state: CallBindingState,
    supersedesBindingId: opaqueIdWithPrefix("cbd").nullable(),
  })
  .superRefine((b, ctx) => {
    if (!isAfter(b.expiresAt, b.occurredAt)) ctx.addIssue({ code: "custom", message: "BINDING_EXPIRY_NOT_AFTER_ISSUE", path: ["expiresAt"] });
    if (b.supersedesBindingId !== null && b.supersedesBindingId === b.bindingId) {
      ctx.addIssue({ code: "custom", message: "BINDING_SUPERSEDES_ITSELF", path: ["supersedesBindingId"] });
    }
  });
export type CallBinding = z.infer<typeof CallBinding>;

/** What a gateway request presents for the binding check. */
export const BindingClaim = z.strictObject({
  tenantId: ENVELOPE_FIELDS.tenantId,
  interactionId: OpaqueId,
  sessionGeneration: ENVELOPE_FIELDS.sessionGeneration,
  fencingToken: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type BindingClaim = z.infer<typeof BindingClaim>;

export type BindingCheck =
  | { current: true }
  | { current: false; reasonCode: "BINDING_NOT_ACTIVE" | "BINDING_EXPIRED" | "BINDING_TENANT_MISMATCH" | "BINDING_INTERACTION_MISMATCH" | "BINDING_GENERATION_STALE" | "BINDING_FENCING_TOKEN_STALE" };

/**
 * Fail-closed currency check of a claim against the stored binding: same tenant and interaction,
 * ACTIVE, unexpired at `now` (independent of storage TTL, AUTH-04), the current session generation
 * and the current fencing token. Any mismatch is refused, never "best effort".
 */
export function checkBinding(binding: CallBinding, claim: BindingClaim, now: Date): BindingCheck {
  if (binding.tenantId !== claim.tenantId) return { current: false, reasonCode: "BINDING_TENANT_MISMATCH" };
  if (binding.interactionId !== claim.interactionId) return { current: false, reasonCode: "BINDING_INTERACTION_MISMATCH" };
  if (binding.state !== "ACTIVE") return { current: false, reasonCode: "BINDING_NOT_ACTIVE" };
  if (Date.parse(binding.expiresAt) <= now.getTime()) return { current: false, reasonCode: "BINDING_EXPIRED" };
  if (binding.sessionGeneration !== claim.sessionGeneration) return { current: false, reasonCode: "BINDING_GENERATION_STALE" };
  if (binding.owner.fencingToken !== claim.fencingToken) return { current: false, reasonCode: "BINDING_FENCING_TOKEN_STALE" };
  return { current: true };
}
