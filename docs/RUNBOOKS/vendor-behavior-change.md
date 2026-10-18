# RB-VENDOR-CHANGE Vendor behaviour change

| Field | Value |
|---|---|
| Runbook id | RB-VENDOR-CHANGE |
| Severity | SEV-2 (SEV-1 if a safety, authorisation or before-speech control is affected) |
| Primary owner role | Talkdesk administrator (or the owner of the affected vendor) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; not executed against any real environment |

## Trigger and detection signals

* Configuration drift: `node talkdesk/tools/drift-check.mjs` (exists offline; live tenant comparison BLOCKED) reports a change against `talkdesk/expected-config.yaml`.
* Version identifiers in interaction exports differ from the pinned agent, model, voice or prompt versions (TB-08, VI-01..VI-03).
* Vendor release notes, deprecation or retirement notice, changed guardrail or Auth Gate semantics, changed MCP tool-definition caching.
* Shifts on `<prefix>-voice-experience` (turn latency, barge-in stop), `<prefix>-safety` (time to routing) or `<prefix>-identity` dashboards without a release on our side.
* Unexpected tool-call fields rejected by the gateway (strict schemas).

## Immediate containment

1. If a control on the capability gate list may be affected (call-context binding, verification entry, protected tool access, before-speech control, early safety signal, guardrail exits, version identity, exports, transfer behaviour, quotas), treat as SEV-1 and engage `AI_ADMISSION` or the relevant `MODEL_VERSION` / `VOICE_VERSION` switch ([kill-switch-operations.md](kill-switch-operations.md)).
2. Otherwise hold new releases and keep the current pinned configuration.

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

* Preserve drift reports, vendor notices, exported configuration and version identifiers, and the release manifest in force.

## Step-by-step actions

1. Ask the vendor for a written description of the change for our actual plan (not a demo tenant).
2. Re-run the affected capability-gate tests in the sandbox (`talkdesk/capability-gate.md`: AG, MB, DT, BS, GX, VI, EX, MC as relevant) and the regression suite for model, voice, prompt, knowledge, schema, vendor and policy changes.
3. Update `docs/vendor-integration-inventory.md` and the prerequisite register; a capability that no longer holds returns to UNKNOWN or BLOCKED.
4. Restore the pinned version through the vendor's rollback mechanism if available (VQ-TD-13), or keep the switch engaged.

## Verification

* Drift check CLEAN against the reviewed configuration, or the new configuration reviewed and adopted in a new release.
* Capability-gate tests re-run with evidence recorded.

## Communication roles

Talkdesk administrator; security leadership (controls); clinical safety lead (safety flow); SRE on-call; QA lead (regression); vendor account team.

## Drill requirement

Tabletop before pilot; first sandbox drift check after AR-01.
