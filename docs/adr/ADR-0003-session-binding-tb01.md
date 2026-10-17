# ADR-0003 Session binding and the TB-01 decision rule

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Final binding mode: **UNKNOWN until TB-01 evidence** (PRQ-013). Argument-supplied session references: **Pending human approval** (exception AR-09 only) |
| Date | 2026-10-17 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Security leadership (any exception); Talkdesk administrator supplies evidence |
| Related prerequisites | PRQ-013, PRQ-018, PRQ-034 |

## Context

The gateway must know which call, actor, subject and assurance a tool request belongs to. Spec
section 7: "The model must not set these fields. Bind the opaque session reference to the
authenticated Talkdesk integration and current call; possession of an interaction ID alone is
not authority." If a vendor cannot pass protected context outside model-controlled arguments,
"the gateway must obtain it through a verified server-to-server lookup or block the protected
tool". Whether Talkdesk can inject a non-model value on every MCP request is UNKNOWN (TB-01,
VQ-TD-23).

## Decision

1. **Server-side session state.** `SessionService` (`platform/src/identity/ports.ts`) stores
   the session in DynamoDB (in-memory `KvStore` fixture offline) and reconstructs `AuthContext`
   on every request. Fields in `SERVER_ESTABLISHED_FIELDS` (`platform/src/protocol/common.ts`)
   are never read from tool arguments (AUTH-03).
2. **Binding checks on every request**: tenant, authenticated integration identity, call id,
   session generation, expiry (enforced in application logic, independent of storage TTL),
   revocation and call end. A participant change, account switch, recovery, risk escalation
   or role change increments the generation and drops privileges.
3. **TB-01 decision rule** (`PlatformConfig.sessionBinding.mode`), applied in order:

   | Order | Mode | Condition |
   |---|---|---|
   | 1 | `trusted_header` | Talkdesk documents injection of the session reference from non-model context on every MCP request, and binding tests MB-01..MB-04 pass |
   | 2 | `server_to_server_lookup` | Talkdesk passes its interaction id outside model arguments and binding tests MB-01..MB-05 pass; the gateway resolves the session that the Studio start-call step bound to (tenant, integration, interaction id). No undocumented vendor API is assumed |
   | 3 | *(blocked)* | Neither is evidenced: the catalogue served to the conversational layer contains only `SAFETY_AND_HUMAN_ROUTE`, `PUBLIC_READ` and A0 intake tools; protected work goes to humans |
   | 4 | `tool_argument_lookup_exception` | Only with an approved security exception (AR-09) recorded in `sessionBinding.exceptionApprovalId`, after reviewing the residual risk that a confused or prompt-injected model presents another session's reference. All binding checks in item 2 still apply |

4. The Talkdesk Auth Gate variable is user experience only. It is initialised `false` at call
   start (never a value that could open the gate) and set only to strict boolean `true` from
   the gateway's `authGate` response. Gateway enforcement remains authoritative whatever the
   gate shows (TB-06, AUTH-07).
5. Transfers may carry a signed, short-lived verification assertion for the same call and an
   authorised receiver; reconnection requires a new session.

## Consequences

* Until PRQ-013 is evidenced, protected tools are not available to the autonomous flow; the
  offline slice exercises all modes with labelled fixtures.
* The sandbox configuration placeholder (`server_to_server_lookup`) is not a decision; the
  final value is set from capability-gate evidence (CG-01).
* Expired sessions fail closed even if DynamoDB TTL has not deleted the item (AUTH-04).

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Trust the interaction id as authority | Spec: possession of an interaction id alone is not authority |
| Session reference as an ordinary tool argument by default | Model-controlled; vulnerable to prompt injection and confused-deputy use |
| Rely on the Talkdesk Auth Gate for authorization | Auth Gate is a component access gate, not an identity provider or authorization system (spec section 2) |
| Long-lived bearer session tokens handed to the vendor | Replay and leakage risk; no server-side revocation guarantee |

## Linked requirements

AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-07, SPEC-7 (trusted session and permission model),
TB-01, TB-06.

## Revisit when

Talkdesk answers VQ-TD-23 in writing for the actual plan, or MB-01..MB-05 have been run in the
sandbox.
