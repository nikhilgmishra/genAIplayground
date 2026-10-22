/** Call parties and lifecycle signals (media/src/lifecycle) [FO-10-01][FO-10-02][FO-10-09]. */
import { describe, expect, it } from "vitest";
import { CallParties } from "../src/lifecycle/parties.js";
import type { ParticipantView } from "../src/lifecycle/parties.js";

const sip = (identity: string, attributes: Record<string, string> = {}): ParticipantView => ({ identity, kind: "SIP", attributes: { "sip.callID": "SCL_synthCall01", "sip.phoneNumber": "+15550100", ...attributes } });
const agent = (identity: string): ParticipantView => ({ identity, kind: "AGENT", attributes: {} });

describe("CallParties [FO-10-02]", () => {
  it("the first SIP/standard participant is the caller; joining is not a change; another party is; agents and recorders are not parties", () => {
    const p = new CallParties();
    p.seed([agent("agent-AJ_old"), sip("sip_caller")]);
    expect(p.caller()).toBe("sip_caller");
    expect(p.joined({ identity: "EG_synthEgress1", kind: "EGRESS", attributes: {} })).toBeNull();
    expect(p.joined(agent("agent-AJ_other"))).toBeNull();
    expect(p.joined(sip("sip_third"))).toEqual({ kind: "PARTICIPANT_JOINED", role: "other" });
    expect(p.left(sip("sip_third"))).toEqual({ kind: "PARTICIPANT_LEFT", role: "other" });
  });

  it("[FO-10-02] a human agent's leg (vsp.participantRole) is a transfer leg, its departure ends the leg", () => {
    const p = new CallParties("sip_caller");
    p.seed([sip("sip_caller")]);
    const human = { identity: "sip_agent_leg", kind: "SIP" as const, attributes: { "vsp.participantRole": "human_agent" } };
    expect(p.joined(human)).toEqual({ kind: "TRANSFER_LEG_STARTED", role: "human_agent" });
    expect(p.left(human)).toEqual({ kind: "TRANSFER_LEG_ENDED", role: "human_agent" });
  });

  it("[FO-10-01] hold is the caller's audio muted (not another participant's); hang-up is the caller leaving or the SIP dialog ending", () => {
    const p = new CallParties();
    p.seed([sip("sip_caller"), sip("sip_other")]);
    expect(p.callerAudioMuted("sip_other", true)).toBeNull();
    expect(p.callerAudioMuted("sip_caller", true)).toEqual({ kind: "HOLD_STARTED", role: "caller" });
    expect(p.callerAudioMuted("sip_caller", true)).toBeNull();
    expect(p.callerAudioMuted("sip_caller", false)).toEqual({ kind: "HOLD_ENDED", role: "caller" });
    expect(p.attributesChanged(sip("sip_caller", { "sip.callStatus": "active" }))).toBeNull();
    expect(p.attributesChanged(sip("sip_caller", { "sip.callStatus": "hangup" }))).toEqual({ kind: "CALLER_HUNG_UP", role: "caller" });
    expect(p.isEnded()).toBe(true);
    expect(p.left(sip("sip_caller"))).toBeNull();
    expect(p.mediaDisconnected()).toBeNull();
  });

  it("the dispatch's named participant is the caller even when another joins first; signals never carry the caller number", () => {
    const p = new CallParties("web_caller");
    expect(p.joined(sip("sip_early"))).toEqual({ kind: "PARTICIPANT_JOINED", role: "other" });
    expect(p.joined({ identity: "web_caller", kind: "STANDARD", attributes: {} })).toBeNull();
    expect(p.left({ identity: "web_caller", kind: "STANDARD", attributes: {} })).toEqual({ kind: "CALLER_HUNG_UP", role: "caller" });
    expect(JSON.stringify(p)).not.toContain("5550100");
  });
});
