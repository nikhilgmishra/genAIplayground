# RB-PHI-EXPOSURE PHI exposure

| Field | Value |
|---|---|
| Runbook id | RB-PHI-EXPOSURE |
| Severity | SEV-1 |
| Primary owner role | Security operations on-call (with privacy counsel) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; not executed against any real environment |

## Trigger and detection signals

* `<prefix>-boundary-violation` alarm when the violation class is privacy (dashboard `<prefix>-safety`, panel "Boundary violations (zero tolerance)").
* `vsp_metric_label_rejections_total` rising (an attempt to put an out-of-enum value into a metric label; dashboard `<prefix>-platform`).
* A staff report, caller complaint, vendor notification or QA reviewer finding PHI in a log, ticket, Case summary, notification, metric, trace, export or developer tool.
* A disclosure to a caller whose relationship or assurance did not permit it (found in audit review or complaint).
* Redaction failure quarantine events.

## Immediate containment

1. Incident commander declares SEV-1. Do not copy the exposed content into chat, tickets or email; refer to it by evidence pointer.
2. Contain the path, narrowest first, using [kill switches](kill-switch-operations.md):
   * disclosure through a tool or intent → engage `INTENT` for that intent;
   * through an integration (Salesforce, notification provider, export) → engage `INTEGRATION` for it, or `OUTBOUND_NOTIFICATIONS`;
   * through the conversational layer → engage `MODEL_VERSION` / `VOICE_VERSION` or `AI_ADMISSION`.
   Safety and human routes stay available in every case.
3. Restrict access to the sink that received the content (log group, ticket, Case, bucket) to security operations; do not delete it.
4. If a vendor holds the copy, the Talkdesk or Salesforce administrator opens a vendor ticket requesting restricted handling (no content in the ticket).

## Evidence preservation

* Place a legal hold on affected records (retention module, PLANNED; until then record the hold scope in the incident record and suspend retention jobs for it).
* Preserve audit events by correlation id (`auditedSearch`), action ledger rows, policy decision ids and policy version, release manifest and configuration versions, vendor interaction ids, and access logs of the receiving sink.
* Record who accessed the exposed content and when, from the sink's own access logs.
* **Privacy counsel determines whether reporting obligations apply, to whom and by when.** The software preserves evidence and supports the process; it does not decide notification.

## Step-by-step actions

1. Identify the path: which component emitted the data, through which field, under which policy decision (audit search by correlation id or call id; PLANNED console view).
2. Determine scope: affected subjects (opaque ids), time window, sinks, copies (exports, backups, vendor copies). Do not enumerate by name in chat.
3. Fix the root cause in code or configuration (for example a missing field mask, a log statement, a metric label, a template slot); add a regression test tagged `[DATA-01]`.
4. Deploy the fix through the normal release path; policy changes follow [policy-release.md](policy-release.md).
5. Purge or quarantine copies only after privacy counsel agrees, and record deletion verification for each derived copy (indexes, caches, backups, exports, vendor copies).
6. Release kill switches one at a time after verification.

## Verification

* The regression test fails on the old code and passes on the fix.
* No new occurrences in the affected sink for an agreed observation window.
* Deletion or quarantine verification recorded for every copy listed in step 2.

## Communication roles

Incident commander; security operations on-call; privacy counsel (reporting decision, external wording); communications lead (only after privacy counsel approval); Talkdesk or Salesforce administrator (vendor tickets); executive sponsor (escalation).

## Drill requirement

Tabletop plus a synthetic injection (a SYNTHETIC record forced into a non-production log group) before pilot; repeated after any change to logging, telemetry or export paths. Record the drill as a `SECURITY_AUDIT` event.
