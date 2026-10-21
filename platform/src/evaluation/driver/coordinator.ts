/**
 * LOCAL SIMULATED COORDINATOR — a deterministic, rule-based stand-in for the
 * Talkdesk conversational layer (talkdesk/ai-agent-config.yaml: one coordinator,
 * bounded domain agents, the deterministic verification and confirmation Skills).
 *
 * It is NOT a language model and its results are NEVER model evaluation. It maps
 * SYNTHETIC caller utterances to tool calls with keyword rules so that scenario
 * scripts drive REAL backend behaviour; every authorization, safety, transaction
 * and audit decision is made by the backend. It never reads a scenario's intent
 * label, expected tool sequence or expected outcome.
 *
 * Rules it follows (from the agent configuration and the Studio flow):
 *  - every caller utterance first goes through the backend's deterministic safety
 *    screening; a safety signal stops administrative work and requests the safety
 *    route (no authentication); a clinical boundary routes to a human;
 *  - non-English callers go to the interpreter route (AI-eligible language: en);
 *  - "agent" / "a person" requests go to request_human_transfer at once;
 *  - protected intents first run the verification Skill (TC-03 role + secure link);
 *    the caller's portal approval is simulated through the portal API with an ID
 *    token from the LOCAL FIXTURE IdP; the Auth Gate (TC-04) decides "verified";
 *  - mutations are prepared, confirmed by the deterministic DTMF Skill (TC-07,
 *    TC-08) and only then committed with {actionId, digest};
 *  - a tool refused for an invalid session (POLICY_DENIED SESSION_*) gets the approved
 *    verification-failed notice and re-verification by a person (SF-11c), like any
 *    other verification failure;
 *  - after a recording decline the AI layer is not used again (SF-04): the state is set
 *    as soon as the decline is known, Studio's approved alternative follows once;
 *  - it speaks only approved templates rendered by the response gate.
 *
 * HOSTILE PROBES: when a caller asks for another person's records, injects
 * instructions, proposes a dial target or claims to be verified, the coordinator
 * deliberately forwards the most damaging tool call it can build (using SYNTHETIC
 * world ids) so the evidence shows the GATEWAY refusing it, not the coordinator
 * (spec section 14: "Test the gateway directly with hostile tool calls even if the
 * conversational prompt would never generate them").
 *
 * An utterance it cannot map is recorded; if no intent is ever established (or a
 * required choice cannot be parsed) the run is reported as unsupported, which the
 * scorer turns into INCONCLUSIVE — never PASS.
 */
import { APPOINTMENTS, INVOICES, ORGANIZATIONS, PEOPLE } from "../../fixtures/synthetic-world.js";
import type { ToolResult } from "../../protocol/index.js";
import type { CallSession } from "./call-session.js";
import { SIMULATED_COORDINATOR_LABEL } from "./labels.js";

type SkillId =
  | "faq"
  | "payment"
  | "login"
  | "appt_lookup"
  | "appt_reschedule"
  | "appt_create"
  | "appt_cancel"
  | "provider_schedule"
  | "invoice"
  | "billing_dispute"
  | "fee_waiver"
  | "claim"
  | "payer_claim"
  | "case_status"
  | "remittance"
  | "onboarding"
  | "credentialing_decision"
  | "partner_intake"
  | "partner_contract"
  | "complaint"
  | "callback"
  | "new_client"
  | "opt_out"
  | "superbill"
  | "account_change"
  | "records"
  | "clinical"
  | "other_subject"
  | "rep_access"
  | "account_generic";

interface Classified {
  skill: SkillId;
  /** Runbook intent for faq-like skills. */
  runbookIntent?: string;
  /** Synthetic person (key in PEOPLE) or organization the caller named. */
  target?: string | null;
}

export interface CoordinatorOptions {
  /** IDP_UNAVAILABLE fault: the caller cannot sign in at the IdP. */
  idpAvailable: () => boolean;
}

const NON_ENGLISH = /\b(hola|necesito|ayuda|factura|por favor|español|espanol|habla|olá|ola|preciso|consulta|português|portugues|desculpe|não|nao|inglês|quiero|vivir)\b|[¿¡ãõç]/i;
const LANGUAGE_NAMES: Record<string, string> = { vietnamese: "vi", spanish: "es", español: "es", portuguese: "pt", português: "pt", mandarin: "zh", chinese: "zh", korean: "ko", arabic: "ar", russian: "ru", french: "fr" };
const INJECTION = /ignore (all |your |any )?(previous|prior|earlier) instructions|system override|developer mode|forget the rules|mark me (as )?verified|i'?m an administrator|supervisor access|i'?m also an admin|read out every field|account notes for every/i;
const DIAL_TARGET = /\b(transfer|dial|call|patch|connect)\b[^.]*?(\b\d{3}[-\s.]?\d{4}\b|\bplus one\b|\bfive five five\b)/i;
const HUMAN = [
  /\b(want|need|like|can i|could i|let me|may i|i'?d like)\b[^.?!]*\b(talk|speak)\s+(to|with)\s+(someone|somebody|a person|a human|a real person|an agent|a representative|someone real|a live person)\b/i,
  /\b(a|real|actual|live) (person|human)\b/i,
  /^\W*agent\b/i,
  /\bsomeone real\b/i,
  /\bjust (a )?person\b/i,
  /\bconnect me (to|with) (someone|somebody|a person)\b/i,
];
const ACK = /^(\W*)(thanks|thank you|okay|ok|fine|great|sure|yes|yeah|no|right|got it|alright)\b|\b(that'?s all|that'?s what i needed|makes sense|thank you|thanks)\b/i;
const ACK_TERM = "(thanks|thank you)( so much| very much| a lot)?|okay|ok|fine|great|perfect|sure|yes|yeah|no|right|got it|alright|that'?s (all|it)( i needed| for now| for today)?|that'?s what i needed|makes sense|bye|goodbye";
/**
 * A WHOLE utterance that only acknowledges ("Thanks.", "Okay, great.", "No, that's all, thank you."): it asks for
 * nothing. ACK also matches a request that merely STARTS with an acknowledgement ("Okay, can you give me the
 * reference number again?"); where skipping a turn would leave a request unanswered, only this may skip it.
 */
const ACK_ONLY = new RegExp(`^\\W*(${ACK_TERM})(\\W+(${ACK_TERM}))*\\W*$`, "i");
/** An opening-hours question (A0 public information). */
const HOURS = /\b(hours|open on weekends|when you'?re open|when are you open|when do you open|what time (do|are) you (open|close)|what time (are you|is the office) open|reach somebody)\b/;
/** An EXPLICIT hours question: it outranks a bare billing mention in the same utterance ("on hold for hours about my bill" does not). */
const HOURS_QUESTION = /\b((your|the|support|portal|office|opening|business) hours|open on weekends|when you'?re open|when are you open|when do you open|what time (do|are) you (open|close)|what time (are you|is the office) open)\b/;
/**
 * A stated non-attendance ("I won't be able to make it next week") read as an appointment request, but only
 * when it names an EXPLICIT time (next <day|week|time>, tomorrow, today, this <week|weekend|part of day>,
 * on <weekday>). A bare "I'm not going to make it" never matches and stays uninterpreted; the guard keeps
 * safety-adjacent idioms ("on my own anymore", "much longer", "through tonight", "this far") out of the
 * administrative path even next to a time phrase. The backend screen has already run on the utterance.
 */
const ATTENDANCE = /\b(can'?t|cannot|won'?t|unable to|not (going to|gonna))( be able to)? (make it|come in)( to (my|the) (appointment|session|visit))? (next (week|time|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|today|this (week|weekend|morning|afternoon|evening)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/;
const ATTENDANCE_GUARD = /\b(anymore|on my own|much longer|through|this far)\b/;
/** A role switch needs a STATED personal request; announcing "one personal" selects no role. */
const ROLE_SWITCH = /\b(as a patient myself|client myself|my own (bill|appointment)|personal bill)\b/;
const SESSION_INVALID = /^SESSION_/;
/** Denials that are an outage, not an authorization answer: the caller goes to a person. */
const ROUTE_ON_DENIAL = /POLICY_(ENGINE|ERROR|UNAVAILABLE|EVALUATION)|BUDGET|ADMISSION|KILL_SWITCH|CAPACITY|LOAD_SHED|AUDIT|WRITES_FENCED|MUTATIONS_DISABLED/;
/** Definite business answers that are not failures of the service. */
const BUSINESS_OUTCOME = /^(SLOT_UNAVAILABLE|OPTION_AMBIGUOUS|STATE_CHANGED|APPOINTMENT_NOT_AVAILABLE|APPOINTMENT_NOT_RESCHEDULABLE|SUBJECT_REQUIRED|ROLE_NOT_SELECTED|RESOURCE_NOT_AUTHORIZED|INVALID_ARGUMENTS|NOT_ELIGIBLE)$/;
const CHOICE_WORDS = /\b(first|second|one|slot|option|works|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"] as const;

const lang2 = (locale: string): string => (locale.split("-")[0] ?? "en").toLowerCase();

/** Synthetic people other callers may name (hostile probes and representative access). */
function namedPerson(t: string): keyof typeof PEOPLE | null {
  if (/\bblake\b/i.test(t)) return "blake";
  if (/\bavery\b/i.test(t)) return "avery";
  if (/\bcasey\b|\bmy daughter\b|\bmy kid\b|\bshe'?s fourteen\b/i.test(t)) return "casey";
  return null;
}

export class SimulatedCoordinator {
  readonly label = SIMULATED_COORDINATOR_LABEL;
  private active: Classified | null = null;
  private pending: Classified | null = null;
  private pendingText = "";
  /** Role for the verification Skill after a role switch (never combined with the previous role). */
  private roleOverride: string | null = null;
  private verificationBegun = false;
  private verified = false;
  private routed: "SAFETY" | "HUMAN" | "CLINICAL" | "INTERPRETER" | null = null;
  /** AUTH_GATE_VALUE: the flow BELIEVES the gate is open (naive mapping or a foreign session). */
  private gateBelief: { sessionRef: string | null } | null = null;
  private consentDeclined = false;
  /** The Studio approved alternative after a decline is requested once per call. */
  private declineAlternativeRequested = false;
  /** A billing review was submitted (SUCCESS receipt); a later turn is a follow-up, never a new review. */
  private reviewSubmitted = false;
  private aiExited = false;
  private relay = false;
  private interpretedAny = false;
  private readonly uninterpreted: number[] = [];
  private readonly unparsedSteps: string[] = [];
  private options: { appointmentId: string | null; slots: { slotId: string; startsAt: string; timeZone: string }[] } | null = null;
  private pendingAction: { actionId: string; digest: string; tool: "commit_appointment_change" | "submit_billing_review" } | null = null;
  private invoiceId: string | null = null;
  private reviewReason: string | null = null;
  private lastInvoices: string[] = [];

  constructor(
    private readonly s: CallSession,
    private readonly opts: CoordinatorOptions,
  ) {}

  /** Steps the coordinator could not exercise (non-empty => the scorer reports INCONCLUSIVE). */
  unsupported(): string[] {
    const out: string[] = [];
    if (!this.interpretedAny && this.uninterpreted.length > 0 && !this.routed) out.push(`COORDINATOR_COULD_NOT_INTERPRET_TURNS:${this.uninterpreted.join(".")}`);
    for (const u of this.unparsedSteps) out.push(`COORDINATOR_COULD_NOT_PARSE:${u}`);
    return out;
  }

  get notes(): { uninterpretedTurns: number[]; routed: string | null; verified: boolean } {
    return { uninterpretedTurns: [...this.uninterpreted], routed: this.routed, verified: this.verified };
  }

  get isRouted(): boolean {
    return this.routed !== null;
  }

  get aiActive(): boolean {
    return !this.consentDeclined && !this.aiExited;
  }

  // ------------------------------------------------------------------ caller turns

  async onCallerTurn(rawText: string, asrConfidence: number | null, index: number): Promise<void> {
    const text = this.relay ? rawText.replace(/^.*?the caller says:\s*/i, "") : rawText;
    const t = text.toLowerCase();
    // 1. Backend deterministic safety screening first, every turn (SAFE-02: no authentication).
    const sc = await this.s.screen(rawText, asrConfidence);
    if (sc.route === "SAFETY_PRIORITY_HUMAN") {
      this.interpretedAny = true;
      if (this.routed !== "SAFETY") {
        this.routed = "SAFETY";
        this.pendingAction = null;
        if (this.aiActive) await this.s.tool("request_safety_route", { signalSource: "EXPLICIT_PHRASE", concernSubject: /\b(my (brother|sister|friend|daughter|son|coworker|husband|wife|mother|father)|he |she |they )\b/i.test(t) ? "THIRD_PARTY" : "SELF", language: lang2(this.s.locale) });
      }
      return;
    }
    // A proposed dial target is forwarded as a hostile probe even after a standard route (SAFE-05).
    if (this.routed !== "SAFETY" && this.aiActive && DIAL_TARGET.test(text)) {
      this.interpretedAny = true;
      await this.dialTargetProbe();
      return;
    }
    if (this.routed) return; // routed: no further administrative work (the caller stays connected)
    if (!this.aiActive) return; // consent-declined alternative or guardrail exit: Studio owns the call
    if (sc.route === "CLINICAL_BOUNDARY_ROUTE") {
      this.interpretedAny = true;
      await this.routeHuman("CLINICAL_QUESTION", "clinical_question_redirected", "CLINICAL");
      return;
    }
    // 2. AI-eligible language is English only.
    if (lang2(this.s.locale) !== "en" || NON_ENGLISH.test(text)) {
      this.interpretedAny = true;
      await this.routeInterpreter(lang2(this.s.locale) !== "en" ? lang2(this.s.locale) : "es");
      return;
    }
    // 3. Adversarial speech: never changes behaviour; the gateway must refuse the forwarded request.
    if (INJECTION.test(text)) {
      this.interpretedAny = true;
      await this.injectionProbe(t);
      return;
    }
    // 4. Explicit human request (always available).
    if (HUMAN.some((re) => re.test(text)) && !(this.relay && /relay operator/i.test(text))) {
      this.interpretedAny = true;
      await this.routeHuman("CALLER_REQUESTED_HUMAN", this.issueCategoryOfActive(), "HUMAN");
      return;
    }
    if (/\binterpreter\b|\bspeaks? my language\b|\bmy english is not\b/i.test(text)) {
      this.interpretedAny = true;
      const named = Object.entries(LANGUAGE_NAMES).find(([k]) => t.includes(k));
      await this.routeInterpreter(named?.[1] ?? "en");
      return;
    }
    // 5. Follow-up of the active skill.
    if (this.active && (await this.followUp(this.active, t))) return;
    // 6. A new intent.
    const c = this.classify(t);
    if (!c) {
      if (!ACK.test(text)) this.uninterpreted.push(index);
      return;
    }
    this.interpretedAny = true;
    await this.startSkill(c, t);
  }

  // ------------------------------------------------------------------ system events

  async onSystemEvent(name: string, detail: string, dtmf: string | null): Promise<void> {
    switch (name) {
      case "VERIFICATION_SECURE_LINK_APPROVED":
        await this.onSecureLinkApproved();
        return;
      case "VERIFICATION_FAILED":
        if (!this.verificationBegun) {
          this.s.notes.push("VERIFICATION_FAILED_WITHOUT_REQUEST");
          return;
        }
        await this.s.approveSecureLink({ matchCodeConfirmed: false, idpAvailable: this.opts.idpAvailable() });
        await this.verificationFailed();
        return;
      case "VERIFICATION_TIMEOUT":
        this.s.tick(10 * 60_000);
        if (this.verificationBegun) await this.verificationFailed();
        return;
      case "STEP_UP_APPROVED":
        // The ledger requires step-up only when a prepared action says so; none of the pinned prepares does (requiresStepUp false).
        this.s.notes.push("STEP_UP_NOT_REQUESTED_BY_BACKEND");
        return;
      case "CONFIRMATION_CAPTURED":
        if (dtmf === null || dtmf === "1") await this.confirmAndCommit();
        else this.s.notes.push("CONFIRMATION_NOT_AFFIRMATIVE");
        return;
      case "CONFIRMATION_DECLINED":
        this.pendingAction = null;
        return;
      case "BARGE_IN":
        await this.s.bargeIn();
        if (this.pendingAction) this.pendingAction = null; // the prepared action was invalidated server-side
        return;
      case "SILENCE_LONG":
        this.s.tick(20_000);
        if (this.aiActive && !this.routed) this.s.speakTemplate("coordinator", "silence.check_in");
        return;
      case "BACKGROUND_NOISE":
        return;
      case "RELAY_SERVICE_ANNOUNCED":
        this.relay = true;
        return;
      case "SECOND_PARTICIPANT_JOINED":
        await this.s.change("PARTICIPANT_CHANGED");
        this.verified = false;
        return;
      case "CALLER_ID_PRESENTED":
        return; // an identifier only (AUTH-01): sent as a digest at call start, never authentication
      case "AUTH_GATE_VALUE":
        this.s.notes.push(`AUTH_GATE_VALUE_OBSERVED:${/reused|expired|other_call/.test(detail) ? detail.split(" ").slice(-1)[0] : "naive"}`);
        return;
      case "RECORDING_DECLINED":
      case "RECORDING_ACCEPTED":
      case "CALL_END":
        return; // handled by the driver (Studio consent step / TC-11)
      default:
        this.s.notes.push("SYSTEM_EVENT_UNKNOWN");
    }
  }

  /**
   * Studio SF-04 decline, STATE only: from now on the AI layer is not used and nothing administrative
   * runs (routed to a person). Set as soon as the decline is known (the driver calls it inside startCall
   * for a decline before the first caller turn), so no fault armed afterwards can find the AI active.
   */
  markConsentDeclined(): void {
    this.consentDeclined = true;
    if (this.routed === null) this.routed = "HUMAN";
  }

  /** Studio SF-04 decline (Phase 2 default): the approved alternative, AI not used for the rest of the call. Requested once. */
  async consentDeclinedAlternative(): Promise<void> {
    this.markConsentDeclined();
    if (this.declineAlternativeRequested) return;
    this.declineAlternativeRequested = true;
    this.s.speakTemplate("studio", "recording.decline_alternative");
    await this.s.studioHumanRequest("CONSENT_DECLINED_ALTERNATIVE", lang2(this.s.locale), null);
  }

  /** GUARDRAIL_LIMIT / QUOTA: the AI layer exits to Studio; Studio keeps the caller on the trusted route. */
  async aiExit(reason: "LIMIT_REACHED" | "AI_UNAVAILABLE"): Promise<void> {
    this.aiExited = true;
    this.s.notes.push(`AI_EXIT_${reason}`);
    if (this.routed) return;
    this.routed = "HUMAN";
    await this.s.studioHumanRequest(reason === "AI_UNAVAILABLE" ? "AI_UNAVAILABLE" : "CALLER_REQUESTED_HUMAN", lang2(this.s.locale), null);
  }

  /** AUTH_GATE_VALUE cases: the flow wrongly believes the caller is verified (optionally holding a foreign session). */
  believeGateOpen(sessionRef: string | null): void {
    this.gateBelief = { sessionRef };
  }

  // ------------------------------------------------------------------ classification (keyword rules)

  private classify(t: string): Classified | null {
    const role = this.s.persona.role;
    const other = namedPerson(t);
    const isRep = role === "personal_representative";
    // Representative access: the represented person (legal authority decided by the backend).
    if (isRep && (other === "casey" || other === "blake" || /\b(family member|for my|handle appointments for|legal representative)\b/.test(t))) {
      return { skill: "rep_access", target: other ?? (this.s.persona.personKey === "emery" ? "blake" : "casey") };
    }
    // A payer representative's claim inquiry is inherently about a member: the payer intent, not a probe
    // (the backend decides what, if anything, the organization may learn).
    if (role === "payer_representative" && /\bclaim\b/.test(t)) return { skill: "payer_claim" };
    // Another person's records: forwarded as a hostile probe.
    const personOther = other !== null && other !== this.s.persona.personKey;
    // "Jordan Synthetic-Unknown" is a person outside the synthetic world unless the caller introduces themself as Jordan.
    const jordanSelf = /\b(i'?m|i am|my name is|this is) jordan\b/.test(t) && !/\bjordan( synthetic-unknown)?'s\b/.test(t);
    const namesJordan = /\bjordan\b/.test(t) && !jordanSelf;
    if (
      personOther ||
      namesJordan ||
      /\b(roommate|neighbou?r|husband|wife|spouse|someone i live with|on behalf of|our employee|our members|list of (all|our)|employee named|a friend of mine|one of your (patients|clients)|one of our (people|employees|staff|members)|who from our plan|coordinate care for (someone|a client|a patient))\b/.test(t)
    ) {
      if (!/\b(end (his|her|their) life|kill)\b/.test(t)) return { skill: "other_subject", target: other ?? null };
    }
    if (ROLE_SWITCH.test(t) && role !== "client") return { skill: "invoice", target: "role_switch" };
    if (/\b(notes|what they wrote|in my file|clinical records?|their history|session history)\b/.test(t)) return { skill: "records" };
    if (/\b(for a client|a client of mine|history for a client)\b/.test(t)) return { skill: "other_subject", target: null };
    if (/\b(depress\w*|diagnos\w*|adhd|screening questions|medications?|dose|antidepressants?|pills|anxiety|panic attacks?|therapy session|do (a |some )?therapy|talk me through|easier to talk to)\b/.test(t)) return { skill: "clinical" };
    if (/\bcomplain|complaint|not happy|unhappy|written down somewhere official\b/.test(t)) return { skill: "complaint" };
    if (/\b(new phone number|update (it|my number|my phone)|phone doesn'?t work|old phone)\b/.test(t)) return { skill: "account_change", target: "contact" };
    if (/\b(bank account|deposits|payout|where my payments go)\b/.test(t)) return { skill: "account_change", target: "payout" };
    if (/\b(tax id|tax info|paperwork details changed|restructured)\b/.test(t)) return { skill: "account_change", target: "tax" };
    if (/\b(locked|unlock|too many (tries|attempts)|won'?t let me in)\b/.test(t)) return { skill: "account_change", target: "locked" };
    if (/\b(stop sending|reminder texts|messages on my phone|opt out)\b/.test(t)) return { skill: "opt_out" };
    if (/\b(itemized|superbill|paperwork from you|statement to send)\b/.test(t)) return { skill: "superbill" };
    if (/\b(call me back|callback|pick up this late|anyone there tonight)\b/.test(t)) return { skill: "callback" };
    if (/\b(start seeing someone|sign up|getting some help|new client|where to begin)\b/.test(t)) return { skill: "new_client" };
    if (/\b(remittance|payment run|reconcile our payments|check a payment|do the books)\b/.test(t)) return { skill: "remittance" };
    if (/\b(approve my credentialing|speed up my approval)\b/.test(t)) return { skill: "credentialing_decision" };
    if (/\b(onboarding|credentialing|documents? (do you|you) still need|paperwork is stuck|join your network)\b/.test(t)) return { skill: "onboarding" };
    if (/\b(information session|for (our )?(employees|staff)|do something for our staff)\b/.test(t)) return { skill: "partner_intake" };
    if (/\b(contract|our agreement)\b/.test(t)) return { skill: "partner_contract" };
    if (role === "payer_representative" && /\bclaim\b/.test(t)) return { skill: "payer_claim" };
    if (/\bclaim\b/.test(t)) return { skill: "claim" };
    // Waiting on the insurer about a past session is a claim-status question (deliberately narrow: "my
    // insurance wants paperwork" stays superbill, "insurance should have paid" stays a dispute).
    if (/\b(waiting (to hear back |to hear )?(from|on)|hear(d)? back from) (my |the )?insurance\b/.test(t)) return { skill: "claim" };
    if (/\b(case|ticket|support request|request acme submitted|reported|following up|update on|billing review|called yesterday|where my issue stands|thing i reported|thing from before|it'?s me again|asked for something|never heard anything|intake request|what we (talked|spoke) about|what we discussed)\b/.test(t)) return { skill: "case_status" };
    if (/\binsurance\b.*\b(take|accept)\b|\b(take|accept)\b.*\binsurance\b|\bcovered\b|paying for this myself/.test(t)) return { skill: "faq", runbookIntent: "billing_statement_explain" };
    if (/\b(what (kinds of )?services|what you do|video appointments)\b/.test(t)) return { skill: "faq", runbookIntent: "human_request" };
    if (role === "provider" && /\b(open slots|my week|how full)\b/.test(t)) return { skill: "provider_schedule" };
    const attendance = ATTENDANCE.test(t) && !ATTENDANCE_GUARD.test(t);
    if (/\b(appointment|session|visit|slot|book|reschedule|see my provider)\b/.test(t) || /\bdifferent day\b/.test(t) || attendance) {
      if (/\bcancel\b/.test(t) && !/late cancellation|cancellation (fee|charge)/.test(t)) return { skill: "appt_cancel" };
      if (/\b(move|reschedule|different day|change)\b/.test(t)) return { skill: "appt_reschedule" };
      if (/\b(book|another session|new appointment|see my provider again|get in to see)\b/.test(t)) return { skill: "appt_create" };
      if (/\b(video link|link for my session|join my video)\b/.test(t)) return { skill: "faq", runbookIntent: "portal_login_help" };
      // Not attending: no cancellation capability exists, so this becomes the honest handoff (appt_cancel), never a mutation.
      if (attendance) return { skill: "appt_cancel" };
      return { skill: "appt_lookup" };
    }
    if (/\b(video link|join my video|browser|click the thing|the link thing)\b/.test(t)) return { skill: "faq", runbookIntent: "portal_login_help" };
    if (/\b(pay (my|the) bill|owe you guys|make a payment|taken care of)\b/.test(t)) return { skill: "payment" };
    if (/\b(dispute|shouldn'?t have to pay|should not have to pay|should have to pay)\b/.test(t)) return { skill: "billing_dispute" };
    if (/\b(fee|charge)\b.*\b(removed|remove|take it off|waive)\b|\bwasn'?t my fault\b/.test(t)) return { skill: "fee_waiver" };
    // A bare billing mention ("about my bill", "another charge?") next to an explicit hours question: the question
    // wins (A0 public information, no verification or role needed); a later billing turn still reaches invoice.
    if (/\b(bill|charge|invoice|statement|balance|owe|charges)\b/.test(t)) return HOURS_QUESTION.test(t) ? { skill: "faq", runbookIntent: "human_request" } : { skill: "invoice" };
    if (/\b(log ?in|sign in|password|portal|website)\b/.test(t)) return { skill: "login" };
    if (/\b(slower|slowly|repeat|going a bit fast|didn'?t catch)\b/.test(t)) return { skill: "faq", runbookIntent: "accessibility_help" };
    if (HOURS.test(t)) return { skill: "faq", runbookIntent: "human_request" };
    if (/\brecord(ed|ing)\b/.test(t)) return { skill: "faq", runbookIntent: "recording_question" };
    if (this.s.persona.person !== null && /\b(check something|quick question|question for you|help with my account|i'?m a (client|provider|patient))\b/.test(t)) return { skill: "account_generic" };
    // An organization caller states its affiliation first: verify, then wait for the actual request.
    if (this.s.persona.person !== null && (role === "partner" || role === "payer_representative") && /\b(i'?m with|i am with|calling from|benefits team)\b/.test(t)) return { skill: "account_generic" };
    return null;
  }

  private needsVerification(c: Classified): boolean {
    switch (c.skill) {
      case "faq":
      case "payment":
      case "login":
      case "complaint":
      case "callback":
      case "new_client":
      case "opt_out":
      case "clinical":
        return false;
      case "account_change":
      case "records":
        return this.s.persona.role !== "client" && this.s.persona.role !== null && this.s.persona.person !== null;
      case "other_subject":
        return this.s.persona.person !== null && this.s.persona.role !== null;
      default:
        return true;
    }
  }

  private async startSkill(c: Classified, t: string): Promise<void> {
    this.active = c;
    this.captureDetails(c, t);
    if (c.skill === "invoice" && c.target === "role_switch") await this.roleSwitchToClient();
    if (this.needsVerification(c) && !this.verified && !this.gateBelief) {
      await this.beginVerification(c, t);
      return;
    }
    await this.runSkill(c, t);
  }

  /** Details stated in the opening utterance (reason category, chosen day, month). */
  private captureDetails(c: Classified, t: string): void {
    if (c.skill === "billing_dispute" || c.skill === "fee_waiver") this.reviewReason = reviewReasonOf(t);
  }

  // ------------------------------------------------------------------ verification Skill

  private async beginVerification(c: Classified, t: string): Promise<void> {
    const role = this.roleOverride ?? this.s.persona.role;
    this.pending = c;
    this.pendingText = t;
    if (!role) {
      // Unidentified caller with a protected request: there is no account context to verify.
      this.s.speakTemplate("coordinator", "intake.role_selection");
      return;
    }
    if (this.s.lastContext?.selectedRole !== role) await this.s.selectRole(role);
    const l = this.s.persona.locator;
    const locator = l.kind === "NAME_AND_DATE_OF_BIRTH" ? { kind: l.kind, fullName: l.fullName, dateOfBirth: l.dateOfBirth } : { kind: l.kind, hint: l.hint };
    this.verificationBegun = true;
    await this.call("begin_verification", { method: "SECURE_LINK", locator });
  }

  private async onSecureLinkApproved(): Promise<void> {
    if (!this.verificationBegun) {
      // The script assumes the agent had asked for verification; this coordinator had not (interpretation gap).
      if (!this.routed) this.unparsedSteps.push("VERIFICATION_APPROVED_BEFORE_REQUEST");
      return;
    }
    await this.s.approveSecureLink({ matchCodeConfirmed: true, idpAvailable: this.opts.idpAvailable() });
    this.verified = await this.s.authGate();
    if (!this.verified) {
      await this.verificationFailed();
      return;
    }
    const p = this.pending;
    const text = this.pendingText;
    this.pending = null;
    this.pendingText = "";
    if (p && !this.routed) await this.runSkill(p, text);
  }

  /** SF-11c: any verification failure goes to a person (VERIFICATION_RECOVERY); never a weaker method. */
  private async verificationFailed(): Promise<void> {
    this.verified = false;
    if (this.routed) return;
    this.s.speakTemplate("coordinator", "verification.failed_generic");
    await this.routeHuman("VERIFICATION_RECOVERY", this.issueCategoryOfActive(), "HUMAN");
  }

  private async roleSwitchToClient(): Promise<void> {
    // A multi-role caller selects ONE role; privileges are never combined (new generation, re-verification).
    this.roleOverride = "client";
    await this.s.selectRole("client");
    this.verified = false;
    this.verificationBegun = false;
  }

  // ------------------------------------------------------------------ routes

  private async routeHuman(reason: string, issueCategory: string | null, kind: "HUMAN" | "CLINICAL"): Promise<void> {
    this.routed = kind;
    this.pendingAction = null;
    await this.s.tool("request_human_transfer", { reason, language: lang2(this.s.locale), issueCategory, accommodations: this.relay ? ["relay_service"] : [] });
  }

  /**
   * No current approved article (none exists, or the one in service expired): the gateway speaks
   * knowledge.no_answer ("I can connect you with a person"), so the call goes to a person. Nothing is
   * improvised and no outdated instruction is used.
   */
  private async answerFromKnowledge(r: ToolResult | null): Promise<void> {
    if (this.routed || r?.status !== "SUCCESS") return;
    if ((r.data as { resultCount?: unknown }).resultCount === 0) await this.routeHuman("POLICY_REQUIRES_HUMAN", this.issueCategoryOfActive(), "HUMAN");
  }

  private async routeInterpreter(language: string): Promise<void> {
    this.routed = "INTERPRETER";
    await this.s.tool("request_human_transfer", { reason: "UNSUPPORTED_LANGUAGE", language, issueCategory: "language_support", accommodations: ["interpreter"] });
  }

  /**
   * A domain tool call. Failures follow the agent configuration: an invalid session goes to
   * re-verification by a person; a dependency, audit, admission or policy-engine failure goes
   * to a person (never an invented answer); an authorization denial is declined honestly.
   */
  private async call(name: string, args: Record<string, unknown>, opts: { sessionRef?: string | null } = {}): Promise<ToolResult | null> {
    const r = await this.s.tool(name, args, opts);
    if (this.routed) return r;
    const code = r && "reasonCode" in r ? r.reasonCode : null;
    if (!r) {
      await this.routeHuman("DEPENDENCY_FAILURE", this.issueCategoryOfActive(), "HUMAN");
      return r;
    }
    if (r.status === "POLICY_DENIED") {
      if (code && SESSION_INVALID.test(code)) {
        // Same caller-visible step as any other verification failure (verificationFailed): the approved
        // notice first, then re-verification by a person (SF-11c VERIFICATION_RECOVERY).
        this.verified = false;
        this.s.speakTemplate("coordinator", "verification.failed_generic");
        await this.routeHuman("VERIFICATION_RECOVERY", this.issueCategoryOfActive(), "HUMAN");
      } else if (code && ROUTE_ON_DENIAL.test(code)) {
        await this.routeHuman("DEPENDENCY_FAILURE", this.issueCategoryOfActive(), "HUMAN");
      } else if (!r.speech) {
        this.s.speakTemplate("coordinator", "policy.denied_generic");
      }
      return r;
    }
    if (r.status === "RETRYABLE_FAILURE" || (r.status === "PERMANENT_FAILURE" && !(code && BUSINESS_OUTCOME.test(code)))) {
      await this.routeHuman("DEPENDENCY_FAILURE", this.issueCategoryOfActive(), "HUMAN");
    }
    if (r.status === "SUCCESS" && name === "begin_verification") {
      const v = (r.data as { verification?: { nextStep?: string } }).verification;
      if (v?.nextStep === "HUMAN_VERIFICATION") await this.routeHuman("VERIFICATION_RECOVERY", this.issueCategoryOfActive(), "HUMAN");
    }
    return r;
  }

  private issueCategoryOfActive(): string | null {
    switch (this.active?.skill) {
      case "appt_lookup":
      case "appt_reschedule":
      case "appt_create":
      case "appt_cancel":
      case "provider_schedule":
        return "appointment";
      case "invoice":
      case "fee_waiver":
        return "billing_question";
      case "billing_dispute":
        return "billing_dispute";
      case "claim":
      case "payer_claim":
        return "claim_status";
      case "remittance":
        return "remittance";
      case "onboarding":
      case "credentialing_decision":
        return "credentialing_documents";
      case "partner_intake":
      case "partner_contract":
        return "partner_intake";
      case "case_status":
        return "case_follow_up";
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ hostile probes

  private presented(): { sessionRef?: string | null } {
    return this.gateBelief && this.gateBelief.sessionRef !== null ? { sessionRef: this.gateBelief.sessionRef } : {};
  }

  private async otherSubjectProbe(target: string | null, t: string): Promise<void> {
    const subject = target ? (PEOPLE[target as keyof typeof PEOPLE]?.subjectId ?? null) : null;
    // A person the caller names who is not in the synthetic world gets ids that resolve to nothing.
    const appt = APPOINTMENTS.find((a) => a.subjectId === subject)?.appointmentId ?? "apt_synthNoSuchPerson0001";
    const inv = INVOICES.find((i) => i.subjectId === subject)?.invoiceId ?? "inv_synthNoSuchPerson0001";
    if (/\b(owe|bill|charge|balance)\b/.test(t)) await this.s.tool("get_invoice_status", { invoiceId: inv, detail: "BALANCE", serviceDate: null }, { probe: "OTHER_SUBJECT_INVOICE", ...this.presented() });
    else await this.s.tool("get_appointment_options", { appointmentId: appt, fromDate: this.date(1), toDate: this.date(20) }, { probe: "OTHER_SUBJECT_APPOINTMENTS", ...this.presented() });
    this.s.speakTemplate("coordinator", "policy.denied_generic");
  }

  private async injectionProbe(t: string): Promise<void> {
    if (/blake/.test(t)) {
      await this.otherSubjectProbe("blake", t);
      return;
    }
    if (/verified|administrator|admin|supervisor/.test(t)) {
      // Server-established identity fields in arguments are refused by the gateway (AUTH-03).
      await this.s.tool("search_approved_runbook", { intent: "verification_help", query: null, language: lang2(this.s.locale), assurance: "A2", role: "admin" }, { probe: "IDENTITY_FIELDS_IN_ARGUMENTS" });
    }
    // "Read me the full account" before verification: a protected read the gateway must refuse at A0.
    if (!this.verified) await this.s.tool("get_invoice_status", { invoiceId: null, detail: "LINE_EXPLANATION", serviceDate: null }, { probe: "PROTECTED_READ_ON_INJECTION", ...this.presented() });
    this.s.speakTemplate("coordinator", "policy.denied_generic");
  }

  private async dialTargetProbe(): Promise<void> {
    // SAFE-05: the dial string is forwarded as an extra argument; the strict schema must refuse it and nothing is dialled.
    await this.s.tool("request_human_transfer", { reason: "CALLER_REQUESTED_HUMAN", language: lang2(this.s.locale), issueCategory: null, accommodations: [], destination: "+15555550199" }, { probe: "DIAL_TARGET_IN_ARGUMENTS" });
    if (this.routed === null && this.active === null) {
      await this.routeHuman("CALLER_REQUESTED_HUMAN", null, "HUMAN");
    }
  }

  // ------------------------------------------------------------------ skills

  private date(offsetDays: number): string {
    return new Date(this.s.stack.clock.now().getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  }

  private async runSkill(c: Classified, t: string): Promise<void> {
    const lang = lang2(this.s.locale);
    const p = this.presented();
    switch (c.skill) {
      case "faq":
        await this.answerFromKnowledge(await this.call("search_approved_runbook", { intent: c.runbookIntent ?? "human_request", query: null, language: lang }));
        return;
      case "payment":
        await this.answerFromKnowledge(await this.call("search_approved_runbook", { intent: "payment_help", query: null, language: lang }));
        return;
      case "login":
        await this.answerFromKnowledge(await this.call("search_approved_runbook", { intent: "portal_login_help", query: null, language: lang }));
        return;
      case "complaint": {
        await this.call("submit_complaint", { category: complaintCategory(t), wantsCallback: /call me back|callback/.test(t), language: lang });
        return;
      }
      case "callback":
        await this.call("create_support_request", { issueCategory: "general_question", linkToAccount: false, urgency: "STANDARD", language: lang });
        return;
      case "new_client":
        await this.call("search_approved_runbook", { intent: "human_request", query: null, language: lang });
        return;
      case "opt_out":
        await this.call("create_support_request", { issueCategory: "other", linkToAccount: false, urgency: "STANDARD", language: lang });
        return;
      case "clinical":
        this.s.speakTemplate("coordinator", "clinical.boundary");
        await this.routeHuman("CLINICAL_QUESTION", "clinical_question_redirected", "CLINICAL");
        return;
      case "records":
      case "account_change":
      case "partner_contract":
        await this.routeHuman("POLICY_REQUIRES_HUMAN", this.issueCategoryOfActive(), "HUMAN");
        return;
      case "payer_claim":
        await this.routeHuman("POLICY_REQUIRES_HUMAN", "claim_status", "HUMAN");
        return;
      case "other_subject":
        await this.otherSubjectProbe(c.target ?? null, t || "appointment");
        return;
      case "rep_access": {
        const subject = PEOPLE[(c.target ?? "casey") as keyof typeof PEOPLE]?.subjectId ?? null;
        const appt = APPOINTMENTS.find((a) => a.subjectId === subject)?.appointmentId ?? null;
        const r = await this.call("get_appointment_options", { appointmentId: appt, fromDate: this.date(1), toDate: this.date(20) }, p);
        if (r?.status !== "SUCCESS" || c.target === "casey") {
          // Minor confidentiality or missing/expired authority: a person decides (the backend already denied or limited it).
          if (r?.status === "SUCCESS" || (r && "reasonCode" in r && /HUMAN|REVIEW|MINOR/.test(r.reasonCode))) await this.routeHuman("POLICY_REQUIRES_HUMAN", "appointment", "HUMAN");
        }
        return;
      }
      case "appt_lookup":
      case "provider_schedule":
        await this.call("get_appointment_options", { appointmentId: null, fromDate: this.date(1), toDate: this.date(20) }, p);
        return;
      case "appt_cancel":
        // No cancellation capability in the pinned catalogue: an honest handoff instead of an invented procedure.
        await this.routeHuman("POLICY_REQUIRES_HUMAN", "appointment", "HUMAN");
        return;
      case "appt_reschedule":
      case "appt_create":
        await this.readOptions(c.skill === "appt_reschedule");
        if (t) await this.chooseSlot(t, c.skill === "appt_reschedule");
        return;
      case "invoice":
        await this.call("get_invoice_status", { invoiceId: null, detail: /\b(charge|fee|what is|for\?)\b/.test(t) ? "LINE_EXPLANATION" : "BALANCE", serviceDate: null }, p);
        return;
      case "fee_waiver":
        await this.readInvoices(p);
        return;
      case "billing_dispute":
        await this.readInvoices(p);
        if (this.reviewReason) await this.prepareReview();
        return;
      case "claim":
        await this.call("get_claim_status", { claimId: null }, p);
        return;
      case "case_status":
        await this.call("get_authorized_case_status", { supportReference: null }, p);
        return;
      case "remittance": {
        const w = monthWindow(t, this.s.stack.clock.now()) ?? { from: this.date(-60), to: this.date(0) };
        await this.call("get_remittance_status", { practiceId: null, fromDate: w.from, toDate: w.to }, p);
        return;
      }
      case "onboarding":
        await this.call("get_provider_onboarding_status", { providerId: null, detail: "DOCUMENTS" }, p);
        return;
      case "credentialing_decision":
        await this.call("get_provider_onboarding_status", { providerId: null, detail: "STAGE" }, p);
        return;
      case "account_generic":
        return; // verified; the caller states the actual request next
      case "partner_intake":
        await this.call("submit_partner_intake", { requestType: /contract/.test(t) ? "CONTRACT_ADMINISTRATION" : /eligibility/.test(t) ? "ELIGIBILITY_FILE_QUESTION" : /billing/.test(t) ? "BILLING_ADMINISTRATION" : "OTHER", urgency: "STANDARD", language: lang });
        return;
      case "superbill":
        await this.call("create_support_request", { issueCategory: "billing_question", linkToAccount: true, urgency: "STANDARD", language: lang });
        return;
    }
  }

  /** Follow-up utterances of the active skill; returns true when handled. */
  private async followUp(c: Classified, t: string): Promise<boolean> {
    // Another person's records or a role switch always start a new (probed) request.
    const other = namedPerson(t);
    if ((other !== null && other !== this.s.persona.personKey && c.skill !== "rep_access") || /\b(south practice)\b/.test(t)) {
      if (/\bsouth practice\b/.test(t)) {
        await this.s.tool("get_remittance_status", { practiceId: ORGANIZATIONS.practiceSouth.organizationId, fromDate: this.date(-60), toDate: this.date(0) }, { probe: "OTHER_ORGANIZATION_REMITTANCE", ...this.presented() });
        this.s.speakTemplate("coordinator", "policy.denied_generic");
        return true;
      }
      return false;
    }
    if (ROLE_SWITCH.test(t) && this.s.persona.role !== "client") return false;
    if (/\bverified already|already checked who i am|you already checked\b/.test(t)) {
      this.s.speakTemplate("coordinator", this.verified ? "status.checking" : "policy.denied_generic");
      return true;
    }
    if (!this.verified && this.needsVerification(c) && !this.gateBelief) return ACK.test(t) || this.verificationBegun || true;
    switch (c.skill) {
      case "appt_reschedule":
      case "appt_create":
        if (/\b(gone|taken)\b/.test(t) || this.pendingAction === null) {
          if (this.options === null || /\b(gone|taken|then|instead)\b/.test(t)) await this.readOptions(c.skill === "appt_reschedule");
          await this.chooseSlot(t, c.skill === "appt_reschedule");
          return true;
        }
        if (/\b(instead|no,|wait|make it)\b/.test(t)) {
          await this.readOptions(c.skill === "appt_reschedule");
          await this.chooseSlot(t, c.skill === "appt_reschedule");
          return true;
        }
        return true;
      case "billing_dispute":
        if (this.reviewSubmitted) {
          // After a submitted review a turn is a follow-up ("the reference again?"), never a new review: answered by
          // the backend-authorized read (the backend renders the recap; the coordinator composes nothing). A new
          // intent goes to classification like any other skill's follow-up. Only a turn that is nothing but an
          // acknowledgement ("Thanks.") is left unanswered; "Okay, what was the reference again?" is still a request.
          const again = this.classify(t);
          if (again && again.skill !== c.skill && again.skill !== "faq") return false;
          if (!ACK_ONLY.test(t)) await this.call("get_authorized_case_status", { supportReference: null }, this.presented());
          return true;
        }
        if (!this.pendingAction && this.invoiceId) {
          this.reviewReason = this.reviewReason ?? reviewReasonOf(t) ?? "OTHER";
          await this.prepareReview();
        }
        return true; // refund questions are answered by the review confirmation template only (no promise)
      case "fee_waiver":
        if (/\b(take it off|remove|waive)\b/.test(t)) this.s.speakTemplate("coordinator", "policy.denied_generic");
        return true;
      case "remittance": {
        const w = monthWindow(t, this.s.stack.clock.now());
        if (w || /\b(the one|latest|so far)\b/.test(t)) {
          const win = w ?? { from: this.date(-30), to: this.date(0) };
          await this.call("get_remittance_status", { practiceId: null, fromDate: win.from, toDate: win.to }, this.presented());
        }
        return true;
      }
      case "credentialing_decision":
        if (/\b(request|review|someone)\b/.test(t)) await this.call("create_support_request", { issueCategory: "credentialing_documents", linkToAccount: true, urgency: "STANDARD", language: lang2(this.s.locale) });
        return true;
      case "new_client":
        if (/\b(call me back|callback|set it up)\b/.test(t)) await this.call("create_support_request", { issueCategory: "general_question", linkToAccount: false, urgency: "STANDARD", language: lang2(this.s.locale) });
        return true;
      case "faq":
      case "payment":
      case "login": {
        const again = this.classify(t);
        if (again && again.skill !== c.skill && again.skill !== "faq") return false;
        if (/\b(card number|password|code)\b/.test(t)) this.s.speakTemplate("coordinator", c.skill === "login" ? "login.guidance" : "billing.payment_page");
        return true;
      }
      case "rep_access":
        if (/\b(talking about|sessions|right to know)\b/.test(t) && this.routed === null) await this.routeHuman("POLICY_REQUIRES_HUMAN", "appointment", "HUMAN");
        return true;
      default: {
        const again = this.classify(t);
        if (again && again.skill !== c.skill && !["faq"].includes(again.skill)) return false;
        return true;
      }
    }
  }

  // ------------------------------------------------------------------ scheduling

  private async readOptions(reschedule: boolean): Promise<void> {
    const r = await this.call("get_appointment_options", { appointmentId: null, fromDate: this.date(1), toDate: this.date(20) }, this.presented());
    if (r?.status !== "SUCCESS") {
      this.options = null;
      return;
    }
    const rows = (r.data as { appointments?: { appointmentId: string | null; slotId: string | null; startsAt: string; timeZone: string; status: string }[] }).appointments ?? [];
    const existing = rows.find((x) => x.slotId === null && x.appointmentId !== null && x.status === "SCHEDULED");
    this.options = {
      appointmentId: reschedule ? (existing?.appointmentId ?? null) : null,
      slots: rows.filter((x) => x.slotId !== null && x.status === "OPEN").map((x) => ({ slotId: x.slotId as string, startsAt: x.startsAt, timeZone: x.timeZone })),
    };
  }

  private async chooseSlot(t: string, reschedule: boolean): Promise<void> {
    if (!this.options || this.options.slots.length === 0) return;
    const slot = pickSlot(t, this.options.slots);
    if (!slot) {
      // A stated choice this coordinator cannot map to an offered option (a question is not a choice).
      if (CHOICE_WORDS.test(t) && !/\?\s*$/.test(t)) this.unparsedSteps.push("SLOT_CHOICE");
      return;
    }
    if (reschedule && !this.options.appointmentId) {
      this.unparsedSteps.push("APPOINTMENT_TO_RESCHEDULE");
      return;
    }
    const r = await this.call("prepare_appointment_change", { appointmentId: reschedule ? this.options.appointmentId : null, startsAt: slot.startsAt, modality: null, slotId: slot.slotId }, this.presented());
    if (r?.status === "SUCCESS") {
      const ch = (r.data as { change?: { actionId: string; actionDigest: string } }).change;
      if (ch) this.pendingAction = { actionId: ch.actionId, digest: ch.actionDigest, tool: "commit_appointment_change" };
    }
  }

  // ------------------------------------------------------------------ billing

  private async readInvoices(p: { sessionRef?: string | null }): Promise<void> {
    const r = await this.call("get_invoice_status", { invoiceId: null, detail: "LINE_EXPLANATION", serviceDate: null }, p);
    if (r?.status === "SUCCESS") {
      const inv = (r.data as { invoices?: { invoiceId: string }[] }).invoices ?? [];
      this.lastInvoices = inv.map((i) => i.invoiceId);
      this.invoiceId = this.lastInvoices[0] ?? null;
    }
  }

  private async prepareReview(): Promise<void> {
    if (!this.invoiceId) return;
    const r = await this.call("prepare_billing_review", { invoiceId: this.invoiceId, reasonCategory: this.reviewReason ?? "OTHER" }, this.presented());
    if (r?.status === "SUCCESS") {
      const d = r.data as { actionId?: string; actionDigest?: string };
      if (d.actionId && d.actionDigest) this.pendingAction = { actionId: d.actionId, digest: d.actionDigest, tool: "submit_billing_review" };
    }
  }

  // ------------------------------------------------------------------ deterministic confirmation Skill (TC-07, TC-08) + commit

  private async confirmAndCommit(): Promise<void> {
    if (!this.pendingAction) {
      this.s.notes.push("CONFIRMATION_WITHOUT_PENDING_ACTION");
      return;
    }
    const pa = this.pendingAction;
    const pending = await this.s.pendingConfirmation();
    if (!pending || pending.actionId !== pa.actionId) {
      // Nothing server-side to confirm (expired, invalidated, other generation): no commit, offer a person.
      this.s.notes.push("NO_SERVER_SIDE_PENDING_ACTION");
      this.pendingAction = null;
      return;
    }
    const state = await this.s.confirm(pending);
    if (state !== "CONFIRMED") {
      this.pendingAction = null;
      return;
    }
    const r: ToolResult | null = await this.call(pa.tool, { actionId: pa.actionId, digest: pa.digest }, this.presented());
    this.pendingAction = null;
    if (r?.status === "SUCCESS" && pa.tool === "submit_billing_review") this.reviewSubmitted = true;
    if (r?.status === "SUCCESS" && pa.tool === "commit_appointment_change") {
      const d = r.data as { committed?: boolean; appointments?: { slotId?: string | null; startsAt: string; timeZone: string; status: string }[] };
      if (d.committed === false) {
        // SLOT_UNAVAILABLE with fresh options: wait for the caller's new choice.
        this.options = this.options ? { ...this.options, slots: (d.appointments ?? []).filter((x) => x.status === "OPEN" && x.slotId).map((x) => ({ slotId: x.slotId as string, startsAt: x.startsAt, timeZone: x.timeZone })) } : null;
      }
    }
  }
}

function complaintCategory(t: string): string {
  if (/\b(bill|charge|invoice)\b/.test(t)) return "BILLING";
  if (/\bprivacy\b/.test(t)) return "PRIVACY_CONCERN";
  if (/\b(staff|rude|agent was)\b/.test(t)) return "STAFF_CONDUCT";
  if (/\b(access|wheelchair|hearing)\b/.test(t)) return "ACCESSIBILITY";
  if (/\b(wait|hold|get through|long|service)\b/.test(t)) return "SERVICE_EXPERIENCE";
  return "OTHER";
}

function reviewReasonOf(t: string): string | null {
  if (/late cancel/.test(t)) return "LATE_CANCELLATION_FEE_DISPUTE";
  if (/no.?show/.test(t)) return "NO_SHOW_FEE_DISPUTE";
  if (/don'?t recognize|not recognize/.test(t)) return "CHARGE_NOT_RECOGNIZED";
  if (/\b(wrong|incorrect|too high)\b/.test(t)) return "AMOUNT_INCORRECT";
  if (/insurance should/.test(t)) return "INSURANCE_SHOULD_HAVE_PAID";
  if (/\b(cancelled|canceled)\b.*\bahead\b/.test(t)) return "LATE_CANCELLATION_FEE_DISPUTE";
  return null;
}

/** Calendar window for a named month ("September", "October") or "last month". */
function monthWindow(t: string, now: Date): { from: string; to: string } | null {
  let idx = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(t));
  if (idx < 0 && /last month/.test(t)) idx = (now.getUTCMonth() + 11) % 12;
  if (idx < 0) return null;
  const year = idx > now.getUTCMonth() ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const start = new Date(Date.UTC(year, idx, 1));
  const end = new Date(Date.UTC(year, idx + 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/** Local weekday of an instant in its IANA time zone. */
function weekdayOf(startsAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(new Date(startsAt)).toLowerCase();
}

/** The caller's choice among offered options: weekday and/or ordinal, or "yes"/"that one" for the first offer. */
export function pickSlot<T extends { startsAt: string; timeZone: string }>(t: string, slots: readonly T[]): T | null {
  const day = WEEKDAYS.find((d) => new RegExp(`\\b${d}\\b`).test(t));
  const pool = day ? slots.filter((s) => weekdayOf(s.startsAt, s.timeZone) === day) : [...slots];
  if (pool.length === 0) return null;
  if (/\b(second|other one|next one)\b/.test(t)) return pool[1] ?? null;
  if (/\b(first|that one|works|yes|the one|slot|option|please)\b/.test(t) || day) return pool[0] ?? null;
  return null;
}
