/**
 * One SYNTHETIC call against the LOCAL stack, as seen from the Talkdesk side:
 *
 *  - Studio deterministic steps over the HTTP telephony-control API (identity
 *    telephony_control): call start with captured consent, role menu, Auth Gate
 *    read, barge-in, participant change, utterance screening, human request,
 *    pending confirmation + trusted DTMF confirmation, call end;
 *  - the caller's own browser over the portal API (identity portal) with an ID
 *    token from the LOCAL FIXTURE OIDC provider for the SYNTHETIC person;
 *  - tool calls (identity mcp_tools) with the trusted session headers.
 *
 * Every caller-visible line is rendered by the gateway's TemplateResponseGate from
 * an approved-template directive (tool SpeechDirective, gateway-rendered
 * confirmation prompt, or a Studio template id). Nothing else is ever "spoken".
 * Observations are content-free (tool names, statuses, reason codes, opaque ids).
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { LOCAL_FIXTURE_TOKENS } from "../../gateway/auth.js";
import { SpeechDirective } from "../../protocol/index.js";
import type { AuthContext, ToolResult } from "../../protocol/index.js";
import { newId, newTurnId } from "../../shared/ids.js";
import { TemplateResponseGate } from "../../voice/gate.js";
import { loadDefaultTemplateRegistry } from "../../voice/registry.js";
import type { CatalogTemplateRegistry } from "../../voice/registry.js";
import type { ToolCallObservation } from "../runner.js";
import type { LocalStack } from "./local-stack.js";
import type { CallerPersona } from "./personas.js";

export interface SpokenLine {
  turnIndex: number;
  source: "tool" | "studio" | "confirmation_prompt" | "coordinator";
  templateId: string;
  responseClass: string | null;
  approvalStatus: string;
  /** Rendered text of the SYNTHETIC approved-template line (null when the gate refused it). */
  text: string | null;
  gate: "RENDERED" | "REJECTED_FALLBACK";
  reasonCode: string | null;
}

export interface ToolObservationRecord extends ToolCallObservation {
  via: "mcp" | "http" | "telephony_control";
  /** Hostile probe label when the coordinator deliberately forwarded a request the gateway must refuse. */
  probe: string | null;
  atMs: number;
  latencyMs: number;
  policyDecisionId: string | null;
  data: Record<string, unknown> | null;
  speechTemplateId: string | null;
}

export interface PendingConfirmation {
  actionId: string;
  digest: string;
  sessionGeneration: number;
  turnId: string;
  promptText: string | null;
  confirmationTemplateId: string;
}

export interface ScreeningOutcome {
  route: "NONE" | "SAFETY_PRIORITY_HUMAN" | "CLINICAL_BOUNDARY_ROUTE";
  handoffId: string | null;
  interpreterRequired: boolean;
  reasonCode: string;
}

export interface ToolHooks {
  beforeTool?: (name: string, session: CallSession) => Promise<void>;
  afterTool?: (name: string, result: ToolResult | null, session: CallSession) => Promise<void>;
}

export interface CallSessionOptions {
  callId?: string;
  /** Excluded from scenario evidence (fixture setup or a concurrent second call). */
  auxiliary?: boolean;
  hooks?: ToolHooks;
}

const SESSION_REASON: Record<string, ToolCallObservation["sessionState"]> = {
  SESSION_EXPIRED: "expired",
  SESSION_REVOKED: "revoked",
  SESSION_ENDED: "revoked",
  SESSION_GENERATION_CHANGED: "revoked",
  SESSION_CALL_MISMATCH: "revoked",
  SESSION_INTEGRATION_MISMATCH: "revoked",
  SESSION_REF_MISSING: "none",
  SESSION_MISSING: "none",
  SESSION_NOT_FOUND: "none",
  SESSION_REF_INVALID: "none",
};

/** Opaque SYNTHETIC interaction id (identifier only, never authority). */
const syntheticCallId = (): string => `cal_synthEval${newId("cal", 12).slice(4)}`;

export class CallSession {
  readonly callId: string;
  readonly auxiliary: boolean;
  sessionRef: string | null = null;
  sessionGeneration = 1;
  expiresAtMs: number | null = null;
  ended = false;
  endReply: { outcome: string | null; reasonCode: string } | null = null;
  turnIndex = 0;
  readonly tools: ToolObservationRecord[] = [];
  readonly spoken: SpokenLine[] = [];
  readonly handoffIds = new Set<string>();
  readonly notes: string[] = [];
  readonly bargeInsMs: number[] = [];
  readonly turnLatencies: number[] = [];
  readonly screenings: ScreeningOutcome[] = [];
  safetySignalAtMs: number | null = null;
  verificationBegunAtMs: number[] = [];
  secureLinkApproved = false;
  maxAssurance: AuthContext["assurance"] = "A0";
  lastContext: AuthContext | null = null;
  consentState: AuthContext["consent"] | null = null;
  recordingStarted = false;
  /** Session reference presented instead of the call's own (AUTH_GATE_VALUE session reuse cases). */
  presentedSessionRef: string | null = null;
  private readonly registry: CatalogTemplateRegistry;
  private readonly gate: TemplateResponseGate;
  hooks: ToolHooks;

  constructor(
    readonly stack: LocalStack,
    readonly persona: CallerPersona,
    readonly locale: string,
    opts: CallSessionOptions = {},
  ) {
    this.callId = opts.callId ?? syntheticCallId();
    this.auxiliary = opts.auxiliary ?? false;
    this.hooks = opts.hooks ?? {};
    this.registry = loadDefaultTemplateRegistry();
    this.gate = new TemplateResponseGate({ registry: this.registry });
  }

  get templateDigest(): string {
    return this.registry.digest();
  }

  private get nowMs(): number {
    return this.stack.clock.now().getTime();
  }

  /** Simulated conversational time between steps (deterministic). */
  tick(ms = 1_500): void {
    this.stack.clock.advanceMs(ms);
  }

  private studioHeaders(sessionRef: string | null = this.sessionRef): Record<string, string> {
    return { ...(sessionRef ? { "x-vsp-session-ref": sessionRef } : {}), "x-vsp-interaction-id": this.callId };
  }

  // ------------------------------------------------------------------ Studio (telephony_control)

  /** SF-04 + SF-06: consent captured by the deterministic Studio step, then TC-01. */
  async start(consent: { recording: "GRANTED" | "DECLINED" | "UNKNOWN"; automatedProcessing: "GRANTED" | "DECLINED" | "UNKNOWN" }, callerIdPresented: boolean): Promise<boolean> {
    const capturedAt = this.stack.clock.now().toISOString();
    const res = await this.stack.inject("POST", "/telephony/v1/calls", "telephony_control", {
      headers: { "x-vsp-interaction-id": this.callId },
      payload: {
        callId: this.callId,
        // AUTH-01: the ANI digest is a risk signal only, never authentication.
        callerIdHash: callerIdPresented ? createHash("sha256").update(this.persona.callerIdE164).digest("hex") : null,
        consent: { ...consent, disclosureTemplateVersion: "disclosure-local-v1", capturedAt, capturedBy: "studio_flow" },
      },
    });
    if (res.status !== 201) {
      this.notes.push(`TC01_STATUS_${res.status}`);
      return false;
    }
    const body = res.body as { sessionRef: string; sessionGeneration: number; expiresAt: string; admission: { admitted: boolean; reasonCode: string } };
    this.sessionRef = body.sessionRef;
    this.sessionGeneration = body.sessionGeneration;
    this.expiresAtMs = Date.parse(body.expiresAt);
    if (!body.admission.admitted) this.notes.push(`AI_NOT_ADMITTED_${body.admission.reasonCode}`);
    // LOCAL Studio stand-in rule: the recorder starts only after GRANTED recording consent (VQ-TD-07 UNKNOWN for Talkdesk).
    this.recordingStarted = consent.recording === "GRANTED";
    await this.refreshContext();
    return true;
  }

  /** TC-02: consent captured mid-call by the deterministic Studio step (e.g. a later decline). */
  async recordConsent(recording: "GRANTED" | "DECLINED"): Promise<boolean> {
    if (!this.sessionRef) return false;
    const res = await this.stack.inject("POST", "/telephony/v1/session/consent", "telephony_control", {
      headers: this.studioHeaders(),
      payload: { recording, automatedProcessing: "GRANTED", disclosureTemplateVersion: "disclosure-local-v1", capturedAt: this.stack.clock.now().toISOString(), capturedBy: "studio_flow" },
    });
    if (res.status === 200) this.sessionGeneration = (res.body as { sessionGeneration: number }).sessionGeneration;
    else this.notes.push(`TC02_STATUS_${res.status}`);
    // LOCAL Studio stand-in: a decline stops the recorder immediately.
    if (recording === "DECLINED") this.recordingStarted = false;
    await this.refreshContext();
    return res.status === 200;
  }

  /** TC-03: the role the caller picked in the deterministic menu. */
  async selectRole(role: string): Promise<boolean> {
    if (!this.sessionRef) return false;
    const res = await this.stack.inject("POST", "/telephony/v1/session/role", "telephony_control", { headers: this.studioHeaders(), payload: { role } });
    if (res.status === 200) this.sessionGeneration = (res.body as { sessionGeneration: number }).sessionGeneration;
    else this.notes.push(`TC03_STATUS_${res.status}`);
    return res.status === 200;
  }

  /** TC-04: strict boolean; only a valid, current A2+ session reads true. */
  async authGate(sessionRef: string | null = this.sessionRef): Promise<boolean> {
    const res = await this.stack.inject("GET", "/telephony/v1/session/auth-gate", "telephony_control", { headers: this.studioHeaders(sessionRef) });
    const body = res.body as { isAuthenticated?: unknown } | null;
    return res.status === 200 && body?.isAuthenticated === true;
  }

  async bargeIn(): Promise<number> {
    if (!this.sessionRef) return 0;
    this.bargeInsMs.push(this.nowMs);
    const res = await this.stack.inject("POST", "/telephony/v1/session/barge-in", "telephony_control", { headers: this.studioHeaders() });
    return res.status === 200 ? ((res.body as { invalidatedActions: number }).invalidatedActions ?? 0) : 0;
  }

  async change(kind: "PARTICIPANT_CHANGED" | "ACCOUNT_SWITCH" | "RECOVERY_STARTED"): Promise<void> {
    if (!this.sessionRef) return;
    const res = await this.stack.inject("POST", "/telephony/v1/session/change", "telephony_control", { headers: this.studioHeaders(), payload: { kind } });
    if (res.status === 200) this.sessionGeneration = (res.body as { sessionGeneration: number }).sessionGeneration;
  }

  /** Early safety signal: the backend's deterministic screening (no authentication needed). Text is transient. */
  async screen(text: string, asrConfidence: number | null): Promise<ScreeningOutcome> {
    const res = await this.stack.inject("POST", "/telephony/v1/session/utterance-screening", "telephony_control", {
      headers: this.studioHeaders(),
      payload: { callId: this.callId, text: text.slice(0, 2000), locale: this.locale, asrConfidence },
    });
    if (res.status !== 200) {
      this.notes.push(`SCREENING_STATUS_${res.status}`);
      const out: ScreeningOutcome = { route: "NONE", handoffId: null, interpreterRequired: false, reasonCode: "SCREENING_UNAVAILABLE" };
      this.screenings.push(out);
      return out;
    }
    const b = res.body as { route: ScreeningOutcome["route"]; handoffId: string | null; speechTemplateId: string | null; interpreterRequired: boolean; reasonCode: string };
    if (b.handoffId) this.handoffIds.add(b.handoffId);
    if (b.route === "SAFETY_PRIORITY_HUMAN" && this.safetySignalAtMs === null) this.safetySignalAtMs = this.nowMs;
    if (b.speechTemplateId) this.speakTemplate("studio", b.speechTemplateId);
    const out: ScreeningOutcome = { route: b.route, handoffId: b.handoffId, interpreterRequired: b.interpreterRequired, reasonCode: b.reasonCode };
    this.screenings.push(out);
    return out;
  }

  /** Studio human request (SF-13 entry without the AI layer), e.g. the consent-declined alternative. */
  async studioHumanRequest(reason: string, language: string, issueCategory: string | null): Promise<boolean> {
    const started = performance.now();
    const res = await this.stack.inject("POST", "/telephony/v1/session/human-request", "telephony_control", {
      headers: this.studioHeaders(),
      payload: { callId: this.callId, reason, language, issueCategory },
    });
    const b = res.status === 200 ? (res.body as { accepted: boolean; handoffId: string | null; speechTemplateId: string; reasonCode: string }) : null;
    if (b?.handoffId) this.handoffIds.add(b.handoffId);
    if (b?.speechTemplateId) this.speakTemplate("studio", b.speechTemplateId);
    this.tools.push({
      name: "request_human_transfer",
      version: null,
      status: b?.accepted ? "SUCCESS" : "PERMANENT_FAILURE",
      turnIndex: this.turnIndex,
      auditEventId: null,
      sessionState: null,
      reasonCode: b ? (b.accepted ? "VIA_STUDIO_TELEPHONY_CONTROL" : b.reasonCode) : `TC_STATUS_${res.status}`,
      via: "telephony_control",
      probe: null,
      atMs: this.nowMs,
      latencyMs: performance.now() - started,
      policyDecisionId: null,
      data: b ? { handoffId: b.handoffId } : null,
      speechTemplateId: b?.speechTemplateId ?? null,
    });
    return b?.accepted === true;
  }

  /** TC-07: the server-side PREPARED action with the gateway-rendered confirmation prompt. */
  async pendingConfirmation(): Promise<PendingConfirmation | null> {
    if (!this.sessionRef) return null;
    const res = await this.stack.inject("GET", "/telephony/v1/session/pending-confirmation", "telephony_control", { headers: this.studioHeaders() });
    if (res.status !== 200) return null;
    const b = res.body as PendingConfirmation & { routeToHuman: boolean };
    const t = this.registry.get(b.confirmationTemplateId, this.locale);
    this.spoken.push({
      turnIndex: this.turnIndex,
      source: "confirmation_prompt",
      templateId: b.confirmationTemplateId,
      responseClass: t?.responseClass ?? null,
      approvalStatus: t ? this.registry.effectiveApproval(t) : "UNKNOWN_TEMPLATE",
      text: b.promptText,
      gate: b.promptText === null ? "REJECTED_FALLBACK" : "RENDERED",
      reasonCode: b.promptText === null ? "ROUTE_TO_HUMAN" : null,
    });
    return b;
  }

  /** TC-08: trusted DTMF confirmation bound to the digest, generation and current confirmation turn. */
  async confirm(p: PendingConfirmation): Promise<string | null> {
    const res = await this.stack.inject("POST", `/telephony/v1/session/actions/${p.actionId}/confirm`, "telephony_control", {
      headers: this.studioHeaders(),
      payload: { digest: p.digest, sessionGeneration: p.sessionGeneration, turnId: p.turnId, method: "dtmf_keypress", capturedAt: this.stack.clock.now().toISOString() },
    });
    if (res.status !== 200) {
      this.notes.push(`TC08_STATUS_${res.status}`);
      return null;
    }
    return (res.body as { state: string }).state;
  }

  /** TC-11: call end; the outcome is recorded by the backend from server-side evidence. */
  async end(reason: "CALLER_HANGUP" | "FLOW_COMPLETED" | "TRANSFERRED"): Promise<void> {
    if (this.ended) return;
    await this.refreshContext();
    const res = await this.stack.inject("POST", "/telephony/v1/session/end", "telephony_control", { headers: this.studioHeaders(), payload: { reason } });
    this.ended = true;
    this.endReply = res.status === 200 ? { outcome: (res.body as { outcome: string | null }).outcome, reasonCode: (res.body as { reasonCode: string }).reasonCode } : { outcome: null, reasonCode: `TC11_STATUS_${res.status}` };
  }

  /** Read-only view of the server-side session (evidence: assurance, consent). Never sent to the coordinator's decisions. */
  async refreshContext(): Promise<AuthContext | null> {
    if (!this.sessionRef || this.ended) return this.lastContext;
    try {
      const integration = await this.stack.container.authenticator.authenticate(`Bearer ${LOCAL_FIXTURE_TOKENS.telephony_control}`, "telephony_control");
      const ctx = await this.stack.container.identity.sessions.resolve(this.sessionRef, integration, { expectedCallId: this.callId });
      this.lastContext = ctx;
      this.consentState = ctx.consent;
      const rank = { A0: 0, A1: 1, A2: 2, A3: 3 } as const;
      if (rank[ctx.assurance] > rank[this.maxAssurance]) this.maxAssurance = ctx.assurance;
      return ctx;
    } catch {
      return this.lastContext;
    }
  }

  // ------------------------------------------------------------------ caller's portal (identity: portal)

  /**
   * The SYNTHETIC caller opens the secure link delivered to their registered
   * channel, signs in at the LOCAL FIXTURE IdP (MFA) and confirms the match code.
   * Returns true only when the gateway bound the account to this session.
   */
  async approveSecureLink(opts: { matchCodeConfirmed: boolean; idpAvailable: boolean }): Promise<boolean> {
    const person = this.persona.person;
    const channelRef = person?.channels[0]?.channelRef ?? null;
    if (!person || !channelRef) {
      this.notes.push("NO_REGISTERED_CHANNEL_NO_LINK_TO_APPROVE");
      return false;
    }
    const msg = this.stack.container.identity.notifications.lastTo(channelRef);
    const path = msg?.slots.linkPath;
    const m = path ? /\/(vtx_[A-Za-z0-9_-]+)#n=([A-Za-z0-9_-]{43})$/.exec(path) : null;
    if (!m || !m[1] || !m[2]) {
      this.notes.push("SECURE_LINK_NOT_DELIVERED");
      return false;
    }
    const link = { transactionId: m[1], nonce: m[2] };
    const described = await this.stack.inject("POST", "/portal/v1/verification/describe", "portal", { payload: link });
    if (described.status !== 200) {
      this.notes.push(`PORTAL_DESCRIBE_${described.status}`);
      return false;
    }
    if (!opts.idpAvailable) {
      this.notes.push("IDP_UNAVAILABLE_NO_ID_TOKEN");
      return false;
    }
    const idToken = await this.stack.container.identity.idp.issueFor(person, { nonce: link.nonce, amr: ["pwd", "mfa"] });
    const approved = await this.stack.inject("POST", "/portal/v1/verification/approve", "portal", { payload: { ...link, idToken, matchCodeConfirmed: opts.matchCodeConfirmed } });
    const bound = approved.status === 200 && (approved.body as { bound?: unknown }).bound === true;
    if (bound) this.secureLinkApproved = true;
    else this.notes.push(`PORTAL_APPROVE_${(approved.body as { reasonCode?: string } | null)?.reasonCode ?? approved.status}`);
    await this.refreshContext();
    return bound;
  }

  // ------------------------------------------------------------------ tools (identity: mcp_tools)

  async tool(name: string, args: Record<string, unknown>, opts: { probe?: string; sessionRef?: string | null } = {}): Promise<ToolResult | null> {
    await this.hooks.beforeTool?.(name, this);
    const presented = opts.sessionRef !== undefined ? opts.sessionRef : (this.presentedSessionRef ?? this.sessionRef);
    if (name === "begin_verification") this.verificationBegunAtMs.push(this.nowMs);
    const reply = await this.stack.callTool(name, args, { sessionRef: presented, callId: this.callId }, { locale: this.locale });
    const r = reply.result;
    const reasonCode = r && "reasonCode" in r ? r.reasonCode : r ? null : `TRANSPORT_${reply.httpStatus}`;
    this.tools.push({
      name,
      version: r?.tool.version ?? "1.0.0",
      status: r?.status ?? "PERMANENT_FAILURE",
      turnIndex: this.turnIndex,
      auditEventId: r?.auditEventId ?? null,
      sessionState: this.sessionStateFor(presented, r),
      reasonCode: reasonCode ?? null,
      via: reply.transport,
      probe: opts.probe ?? null,
      atMs: this.nowMs,
      latencyMs: reply.latencyMs,
      policyDecisionId: r?.policyDecisionId ?? null,
      data: r && (r.status === "SUCCESS" || r.status === "PENDING") ? r.data : null,
      speechTemplateId: r?.speech?.templateId ?? null,
    });
    if (r?.status === "SUCCESS") {
      const handoff = (r.data as { handoff?: { handoffId?: unknown } }).handoff;
      if (handoff && typeof handoff.handoffId === "string") this.handoffIds.add(handoff.handoffId);
    }
    if (r?.speech) this.speakDirective("tool", r.speech, r.policyDecisionId);
    this.tick(800);
    await this.hooks.afterTool?.(name, r, this);
    return r;
  }

  /** Session state of the presented reference as the gateway resolved it (backend reason codes first). */
  private sessionStateFor(presented: string | null, r: ToolResult | null): ToolCallObservation["sessionState"] {
    if (!presented) return "none";
    const code = r && "reasonCode" in r ? r.reasonCode : null;
    if (code && SESSION_REASON[code] !== undefined) return SESSION_REASON[code] ?? null;
    if (presented !== this.sessionRef) return "revoked";
    if (this.ended) return "revoked";
    if (this.expiresAtMs !== null && this.nowMs >= this.expiresAtMs) return "expired";
    return "valid";
  }

  // ------------------------------------------------------------------ speech (approved templates through the gate)

  private speakDirective(source: SpokenLine["source"], directive: SpeechDirective, policyDecisionId: string | null): void {
    const t = this.registry.get(directive.templateId, this.locale);
    const rendered = this.gate.render(directive, {
      sessionRef: this.sessionRef ?? "ses_bnd_unbound",
      currentTurnId: directive.turnId,
      sessionGeneration: Math.max(1, directive.sessionGeneration),
      validAuthorizationRefs: new Set(policyDecisionId ? [policyDecisionId] : []),
      locale: this.locale,
      environment: "local",
    });
    this.spoken.push({
      turnIndex: this.turnIndex,
      source,
      templateId: rendered.ok ? rendered.templateId : rendered.fallbackTemplateId,
      responseClass: t?.responseClass ?? null,
      approvalStatus: t ? this.registry.effectiveApproval(t) : "UNKNOWN_TEMPLATE",
      text: rendered.ok ? rendered.utterance : rendered.fallbackUtterance,
      gate: rendered.ok ? "RENDERED" : "REJECTED_FALLBACK",
      reasonCode: rendered.ok ? null : rendered.reasonCode,
    });
  }

  /** A slot-free approved template (Studio prompts and the coordinator's generic lines). */
  speakTemplate(source: SpokenLine["source"], templateId: string): void {
    const t = this.registry.get(templateId, this.locale) ?? this.registry.get(templateId, "en-US");
    if (!t) {
      this.notes.push("TEMPLATE_NOT_FOUND");
      return;
    }
    const directive = SpeechDirective.safeParse({
      templateId: t.templateId,
      templateVersion: t.version,
      responseClass: t.responseClass,
      slots: {},
      authorizationRef: null,
      sourceRefs: [],
      turnId: newTurnId(),
      sessionGeneration: Math.max(1, this.sessionGeneration),
    });
    if (!directive.success) return;
    this.speakDirective(source, directive.data, null);
  }
}
