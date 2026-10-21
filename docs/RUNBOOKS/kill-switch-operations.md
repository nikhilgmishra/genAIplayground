# RB-KILL-SWITCH Kill switch operations

| Field | Value |
|---|---|
| Runbook id | RB-KILL-SWITCH |
| Severity | Procedure (used inside SEV-1/SEV-2 runbooks) |
| Primary owner role | Supervisor or security admin (model and voice switches also deployment operator) |
| Last drilled | NEVER (not yet run) |
| Status | Draft. `KillSwitchService`, the console API (`killSwitches.*`) and the console Kill switches page exist and are tested offline (`platform/src/ops`, `platform/src/console-api`, `console/`) with LOCAL FIXTURE sign-in only; workforce SSO is BLOCKED (PRQ-036) |

## Switches

Separate kill switches exist for each scope (`KillSwitchScope`, `platform/src/protocol/contracts.ts`).
**Every switch preserves the approved safety and human routes**; those routes are never gated.

| Scope | Target | Effect | Allowed roles (`KILL_SWITCH_ROLES`) |
|---|---|---|---|
| `AI_ADMISSION` | `*` | No new AI sessions; callers go to staffed queues through the continuity route | security_admin, supervisor |
| `INTENT` | intent id | Intent no longer offered; intake or human handoff instead | security_admin, supervisor |
| `INTEGRATION` | integration id (for example `salesforce`, `scheduling`, `notifications`) | Gateway tool calls whose policy action lists the integration are refused; dependent intents degrade. `salesforce`: the worker's support-record sync is held before it claims the request: no attempt is spent, nothing is dead-lettered, the request stays `PENDING` with `last_sync_reason = KILL_SWITCH_INTEGRATION` (audited `support_request.sync_held`), the retry sweep enqueues nothing, and the request syncs once after release (OPS-KS-02). `notifications`: every secure-link, step-up and OTP send is refused before the provider, and callers who start verification get the same answer as under `OUTBOUND_NOTIFICATIONS` (see that row; OPS-KS-01; audited reason `KILL_SWITCH_INTEGRATION`). Other background provider calls (for example `actions.reconcile` lookups) are **not** gated | security_admin, supervisor |
| `WRITES` | `*` | All consequential commits refused, including a staff retry of a reconciled operation (the retry re-evaluates the switches, ACT-F3); Salesforce support-record upserts are held like `INTEGRATION salesforce` (`last_sync_reason = KILL_SWITCH_WRITES`); reads may continue | security_admin, supervisor |
| `MODEL_VERSION` | version label | Sessions on that model version refused | security_admin, supervisor, deployment_operator |
| `VOICE_VERSION` | version label | Sessions on that voice version refused | security_admin, supervisor, deployment_operator |
| `OUTBOUND_NOTIFICATIONS` | `*` | No outbound notifications: every secure-link, step-up and OTP send goes through `KillSwitchGatedNotificationSender` (composed once in `platform/src/main/container.ts` for every sender) and is refused before the provider with `KILL_SWITCH_OUTBOUND_NOTIFICATIONS` (unreadable switch state also refuses, OPS-KS-01). Only staff safety-escalation paging, fixed at composition, is exempt; no safety or human route sends notifications. Caller-facing answer (OPS-KS-01; the verification service reads the same switch state, `notificationSwitches`): verification does not pretend a message was sent. Every begin (secure link, OTP, step-up) answers `VERIFICATION_UNAVAILABLE_USE_HUMAN` before any account lookup, the caller hears the `verification.failed_generic` prompt ("I wasn't able to complete verification. I can connect you with a person who can help."; the template is still DRAFT, pending support-operations review) and is offered the human route. The answer is the same for every caller, so it reveals nothing about any account, and no verification throttle is spent. The begin is audited with reason `KILL_SWITCH_OUTBOUND_NOTIFICATIONS` (`tool.invoke` over MCP; `verification.begun` with outcome `DENIED` over telephony control); an unreadable switch state gives `KILL_SWITCH_STATE_UNAVAILABLE` | security_admin, supervisor |

## Trigger and detection signals

Called from other runbooks. Dashboard `<prefix>-admission-controls`, panel "Kill switches engaged" (`vsp_killswitch_engaged`); `vsp_killswitch_snapshot_failures_total` above zero means instances may not see the current state (every enforcement point then fails closed: tool calls other than the safety and human routes, notification sends and Salesforce sync are all held).

## Immediate containment (engaging a switch)

1. Authenticate to the console through workforce SSO with MFA (BLOCKED, PRQ-036; offline only the LOCAL FIXTURE sign-in exists). The service enforces MFA and role; the console requires a reason code and the typed confirmation `ENGAGE <scope> <target>`.
2. Choose the **narrowest** switch that contains the problem.
3. Enter a reason (reason text is operational, never PHI) and engage. The change is written as an audit event with a correlation id; if the audit write fails, the change is refused.
4. Confirm propagation: with the default `cacheTtlMs` of 0 every check reads current state; with a positive TTL allow up to that TTL to reach every instance.
5. `OUTBOUND_NOTIFICATIONS` / `INTEGRATION notifications`: tell the support operations lead that every caller who needs verification now goes to a staffed queue (verification by a person), so queue demand rises for the duration. A begin that read the switch state just before the switch took effect may still answer "if the details match an account, a link has been sent"; its send is refused, so offer the human route to anyone who reports no message.

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

Switch changes are audited automatically (actor, scope, target, reason, time). Reference the switch id in the incident record.

## Step-by-step actions (releasing a switch)

1. Confirm the root cause is fixed and verified in the owning runbook.
2. Release one switch at a time; watch the owning dashboard for an agreed observation window.
3. For `AI_ADMISSION`, ramp gradually (cohort or calls per day).
4. After releasing `OUTBOUND_NOTIFICATIONS` or `INTEGRATION notifications`, run one synthetic secure-link verification and confirm it answers `IF_ELIGIBLE_A_LINK_WAS_SENT` and the link arrives. Calls in progress can verify again at once: the switched-off attempts did not use their per-call attempt limit.
5. After releasing `INTEGRATION salesforce` or `WRITES`, confirm the held support requests sync: the `support.sync_retry` sweep re-enqueues them (each with its own dedupe key) and each creates exactly one Case. Nothing needs a DLQ repair, because a held request is never dead-lettered.

## Verification

* `vsp_killswitch_engaged` reflects the intended state; admission decisions and tool denials show the switch reason code while engaged.
* `INTEGRATION salesforce` / `WRITES`: support requests created while engaged stay `PENDING` with `last_sync_reason = KILL_SWITCH_*` and are `SYNCED` after release; none are `DEAD_LETTER`.
* `OUTBOUND_NOTIFICATIONS` / `INTEGRATION notifications`: the notification provider (fixture offline) receives no send while engaged. A synthetic `begin_verification` for a real and an unknown synthetic person both answer `VERIFICATION_UNAVAILABLE_USE_HUMAN` with `nextStep: HUMAN_VERIFICATION` and the `verification.failed_generic` template, and their audit events carry the switch reason code. Offline evidence: `[OPS-KS-01]` tests in `platform/src/identity/verification-service.test.ts`, `platform/src/gateway/tools/verification.test.ts` and `platform/src/gateway/http/routes.test.ts` (identity and gateway test harnesses) and `platform/src/ops/notification-gate.test.ts` (composed LOCAL container, MCP and telephony control); nothing has been exercised against a live environment.
* A synthetic safety request and a synthetic human request succeed while any switch is engaged.

## Communication roles

Supervisor or security admin (operator); incident commander (decision); SRE on-call; support operations lead (queue impact).

## Drill requirement

Engage and release each scope in a non-production environment before pilot, proving the safety and human routes stay available; repeat quarterly (cadence to be set by the SRE lead).
