# ADR-0006 Fallback speech runtime (self-hosted LiveKit on AWS) is a separately approved project, not a silent substitution

| Field | Value |
|---|---|
| Status | **Superseded by ADR-0018** ([ADR-0018](ADR-0018-followon-product-architecture.md), 2026-10-19): the follow-on prompt makes the controllable LiveKit runtime mandatory software, so the conditional "build no speech runtime unless TB-04 or TB-05 fail" decision no longer applies. Previous status: Proposed — Pending human approval, triggered only if TB-04 or TB-05 fail (PRQ-016, PRQ-017). Its fail-closed rules stay in force for the Talkdesk-native adapter only |
| Date | 2026-10-17 |
| Decided by | Not decided; this ADR records the conditional design direction from spec section 3 |
| Approval needed from | Executive sponsor, security leadership, privacy counsel, procurement, finance |
| Related prerequisites | PRQ-016, PRQ-017, PRQ-002, PRQ-045 |

## Context

Spec section 3: "If native AI cannot prevent a protected response from being spoken before
authorization and validation, do not claim that a prompt fixes the gap. Keep Talkdesk telephony
and propose a separately approved speech runtime over a supported SIP or media interface. The
fallback design is a self-hosted LiveKit media layer on AWS with separately controllable ASR,
text generation, output approval, and TTS. It is a new engineering and vendor review, not a
silent substitution or a three-day detour." Whether Talkdesk offers a supported SIP or media
interface for this is UNKNOWN (VQ-TD-42). ElevenLabs is only an optional future voice-quality
candidate; its documentation states MCP is not available for users requiring HIPAA compliance or
Zero Retention Mode (S13, S14).

## Decision

1. No fallback speech runtime is implemented or deployed in this repository. Nothing is
   substituted silently if TB-04 or TB-05 fail.
2. The response gate (`ResponseGate`, `platform/src/voice/ports.ts`) and the `SpeechDirective`
   protocol are runtime-agnostic, so a future runtime can reuse the same approved templates,
   turn ids and session-generation checks.
3. If PRQ-016 or PRQ-017 ends in a FAIL, engineering prepares a separate proposal: scope,
   media path, vendors for ASR/TTS/model, BAA and zero-retention verification per endpoint,
   threat model delta, capacity and cost estimate, rollback and timeline. It proceeds only
   after explicit approvals.
4. Until then, protected response classes use deterministic rendering only, and an autonomous
   flow that cannot meet TB-05 does not launch.

## Consequences

* A failed capability gate may reduce automation substantially; that is the intended outcome,
  not a reason to weaken a control.
* No LiveKit, ASR, TTS or model vendor is assumed to be contracted, covered or available.

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Prompt-only mitigation of before-speech risk | Spec: a prompt does not fix the gap |
| Retrospective transcript scanning | Cannot retract audio already spoken |
| Switching to ElevenLabs agents with MCP | Documentation states MCP is unavailable under HIPAA / Zero Retention Mode; no feature parity assumed |
| Building the fallback now | Unapproved vendor, contract, cost and PHI scope |

## Linked requirements

ACT-05, SAFE-03, DATA-01, OPS-05, TB-04, TB-05, SPEC-3 (vendor capability gate), SPEC-11
(validate protected responses before the first audible segment).

## Revisit when

Capability gate CG-04 or CG-05 records a FAIL, or Talkdesk answers VQ-TD-42.
