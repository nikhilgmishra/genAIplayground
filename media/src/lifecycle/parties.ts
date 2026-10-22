/**
 * Call parties and lifecycle signals of one room (WP-11; FO-10-01, FO-10-02, FO-10-09).
 *
 * A pure classifier over what the media plane reports (participant joined or left, the caller's audio muted or
 * unmuted, a SIP call status, the runtime's own room connection lost). It decides who the caller is, which
 * participant is a human agent's transfer leg and which is a third party, and turns each change into the
 * lifecycle event the gateway records (MediaLifecycleEventKind). It never reads or keeps a caller number: a SIP
 * participant's `sip.phoneNumber` attribute is ignored.
 *
 * Roles: the caller is the participant the job was dispatched for, else the first SIP or standard participant;
 * a participant whose `vsp.participantRole` attribute is `human_agent` (set by the transfer service through the
 * server API when it dials the human leg; caller tokens carry no metadata-update grant, so a caller cannot set it)
 * is a transfer leg; any other SIP or standard participant is a third party (consent and privileges reset).
 * Agents and egress recorders are not call parties.
 */
import type { MediaLifecycleEventKind, MediaParticipantRole } from "@vsp/platform/src/protocol/call-binding.js";

/** livekit ParticipantInfo.Kind names (rtc-node ParticipantKind values 0..5 map to these). */
export type ParticipantKindName = "STANDARD" | "INGRESS" | "EGRESS" | "SIP" | "AGENT" | "CONNECTOR" | "UNKNOWN";

export const KIND_BY_NUMBER: Readonly<Record<number, ParticipantKindName>> = { 0: "STANDARD", 1: "INGRESS", 2: "EGRESS", 3: "SIP", 4: "AGENT", 5: "CONNECTOR" };

export interface ParticipantView {
  identity: string;
  kind: ParticipantKindName;
  attributes: Readonly<Record<string, string>>;
}

export interface LifecycleSignal {
  kind: MediaLifecycleEventKind;
  role: MediaParticipantRole | null;
}

export const ROLE_ATTRIBUTE = "vsp.participantRole";
const SIP_STATUS_ATTRIBUTE = "sip.callStatus";

function isParty(p: ParticipantView): boolean {
  return p.kind === "SIP" || p.kind === "STANDARD";
}

export class CallParties {
  private callerIdentity: string | null;
  private readonly present = new Map<string, MediaParticipantRole>();
  private held = false;
  private ended = false;

  /** `expectedCaller` is the participant identity the job was dispatched for, when the dispatch names one. */
  constructor(expectedCaller: string | null = null) {
    this.callerIdentity = expectedCaller;
  }

  caller(): string | null {
    return this.callerIdentity;
  }

  isCaller(identity: string): boolean {
    return identity === this.callerIdentity;
  }

  roleOf(identity: string): MediaParticipantRole | null {
    return this.present.get(identity) ?? null;
  }

  isHeld(): boolean {
    return this.held;
  }

  isEnded(): boolean {
    return this.ended;
  }

  /** The participants already in the room when the runtime joined: the caller is found, nothing is a change. */
  seed(participants: readonly ParticipantView[]): void {
    for (const p of participants) this.classify(p);
  }

  joined(p: ParticipantView): LifecycleSignal | null {
    if (this.ended || !isParty(p) || this.present.has(p.identity)) return null;
    const role = this.classify(p);
    if (role === "caller") return null; // the call itself starting is not a change of party
    if (role === "human_agent") return { kind: "TRANSFER_LEG_STARTED", role };
    return { kind: "PARTICIPANT_JOINED", role };
  }

  left(p: ParticipantView): LifecycleSignal | null {
    const role = this.present.get(p.identity);
    if (this.ended || role === undefined) return null;
    this.present.delete(p.identity);
    if (role === "caller") return this.end();
    if (role === "human_agent") return { kind: "TRANSFER_LEG_ENDED", role };
    return { kind: "PARTICIPANT_LEFT", role };
  }

  /** The caller's audio was muted (a SIP re-INVITE to hold) or unmuted. Other participants' mutes are not holds. */
  callerAudioMuted(identity: string, muted: boolean): LifecycleSignal | null {
    if (this.ended || !this.isCaller(identity) || muted === this.held) return null;
    this.held = muted;
    return { kind: muted ? "HOLD_STARTED" : "HOLD_ENDED", role: "caller" };
  }

  /** livekit-sip reports the SIP dialog's state as a participant attribute; `hangup` ends the call. */
  attributesChanged(p: ParticipantView): LifecycleSignal | null {
    if (this.ended || !this.isCaller(p.identity)) return null;
    return p.attributes[SIP_STATUS_ATTRIBUTE] === "hangup" ? this.end() : null;
  }

  /** The runtime's own room connection was lost (not a caller action). */
  mediaDisconnected(): LifecycleSignal | null {
    if (this.ended) return null;
    return { kind: "MEDIA_DISCONNECTED", role: null };
  }

  private end(): LifecycleSignal {
    this.ended = true;
    return { kind: "CALLER_HUNG_UP", role: "caller" };
  }

  private classify(p: ParticipantView): MediaParticipantRole | null {
    if (!isParty(p)) return null;
    let role: MediaParticipantRole;
    if (p.attributes[ROLE_ATTRIBUTE] === "human_agent") role = "human_agent";
    else if (this.callerIdentity === null || this.callerIdentity === p.identity) {
      this.callerIdentity = p.identity;
      role = "caller";
    } else role = "other";
    this.present.set(p.identity, role);
    return role;
  }
}
