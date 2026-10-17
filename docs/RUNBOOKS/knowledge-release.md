# RB-KNOWLEDGE-RELEASE Knowledge release

| Field | Value |
|---|---|
| Runbook id | RB-KNOWLEDGE-RELEASE |
| Severity | Procedure (emergency withdrawal: SEV-2) |
| Primary owner role | Knowledge owner (with clinical safety lead and privacy counsel) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; knowledge module under implementation. Approval scope `KNOWLEDGE_RELEASE` (PRQ-032) |

## Trigger and detection signals

New or changed public FAQ or approved runbook content; Salesforce Knowledge changes (export path UNKNOWN, VQ-SF-09); dashboard `<prefix>-knowledge`: oldest approved item age (`vsp_knowledge_freshness_age_seconds`) or items needing review (`vsp_knowledge_items_needing_review`); a wrong or unsafe answer traced to an article ([unsafe-output.md](unsafe-output.md)).

## Immediate containment

Emergency withdrawal: mark the article version withdrawn (knowledge editor) so retrieval stops returning it; if the whole snapshot is suspect, roll back to the previous approved snapshot.

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

Retain the item metadata (owner, audience, permitted intent, jurisdiction, language, effective and expiry dates, sensitivity, approval, version), the sanitisation report, the snapshot digest and the approval record id.

## Step-by-step actions

1. Ingest through the controlled pipeline, never a blind paste of operational documents.
2. Sanitisation removes embedded instructions, links, attachments and executable content; review the sanitisation report.
3. Apply approved source precedence; conflicting or expired items go to human review, not to callers.
4. Confirm no customer transcripts or therapy content are in the corpus; never build an embedding index of customer transcripts.
5. Build the snapshot; record its digest (pinned in the ReleaseManifest as `knowledgeSnapshotDigest`).
6. Knowledge owner, clinical safety lead (for anything near clinical boundaries) and privacy counsel review; the approver creates the `KNOWLEDGE_RELEASE` record.
7. Run the knowledge-grounding regression for affected intents; citation ids and exact article versions must accompany every policy-derived response.

## Verification

Retrieval returns only approved, unexpired items filtered by authorisation before and after search; regression passes.

## Communication roles

Knowledge owner; knowledge editor; clinical safety lead; privacy counsel; QA lead.

## Drill requirement

Release and emergency-withdrawal rehearsal in a non-production environment before pilot.
