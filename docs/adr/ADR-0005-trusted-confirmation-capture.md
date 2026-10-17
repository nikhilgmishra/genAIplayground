# ADR-0005 Confirmation of consequential actions is captured by a trusted deterministic component (TB-02)

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Autonomous commit: **BLOCKED until TB-02 evidence** (PRQ-014) |
| Date | 2026-10-17 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Security leadership (confirm the mechanism once evidenced) |
| Related prerequisites | PRQ-014, PRQ-034 |

## Context

ACT-01 requires fresh, transaction-bound confirmation for every consequential action. Spec
section 8: bind affirmative confirmation to the digest of the prepared action; a generic "yes"
from an earlier turn is not consent for another action. If the model reports that "the caller
said yes", the confirmation is model-controlled and could be fabricated by prompt injection or
misrecognition. Whether a deterministic Studio step or Skill can capture confirmation and call
the gateway with its own service identity is UNKNOWN (TB-02, VQ-TD-27, VQ-TD-28).

## Decision

1. Mutations use prepare → confirm → commit (`ActionService`, `platform/src/actions/ports.ts`).
   Prepare stores the authoritative target, before-state version, exact change, impact, fees,
   policy decision, expiry and confirmation phrase, and returns a digest.
2. **Confirmation is accepted only from a trusted deterministic component**: a Studio
   deterministic step (DTMF or bounded affirmative capture) calling the telephony-control API
   with the `telephony_control` service identity, or a human agent through the console. The
   confirmation names the prepared-action digest, turn id and session generation.
3. The MCP identity (`mcp_tools`, used by the model-driven layer) can prepare but cannot
   confirm. A confirmation presented over `/mcp` is rejected.
4. Commit rechecks authorisation, freshness, current state and confirmation; interruption,
   changed request, ambiguous confirmation, identity change or expired preparation invalidates
   the pending action.
5. Until PRQ-014 is evidenced, commit tools are `enabledInAutonomousFlow: false` in the Talkdesk
   configuration and a human agent confirms and commits through supported console controls.

## Consequences

* The autonomous flow can explain and prepare a change but cannot complete it until TB-02 is
  proven, which reduces automation but keeps ACT-01 intact.
* Confirmation capture adds a Studio sub-flow and a return to the agent conversation, whose
  behaviour is itself UNKNOWN (VQ-TD-28).
* Step-up (A3) is also transaction-bound to the same digest.

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Model passes `confirmed: true` | Model-controlled; violates ACT-01 and AUTH-03 |
| Transcript keyword check after the fact | Retrospective; misrecognition and injection; not bound to the digest |
| Generic session-level consent | Spec: a generic yes is not consent for another action |

## Linked requirements

ACT-01, ACT-03, ACT-05, AUTH-03, TB-02, SPEC-8 (preparing and committing changes).

## Revisit when

Talkdesk answers VQ-TD-27 and VQ-TD-28 in writing, and the sandbox tests for capability gate
CG-03 have run.
