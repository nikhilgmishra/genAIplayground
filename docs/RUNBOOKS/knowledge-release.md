# RB-KNOWLEDGE-RELEASE Knowledge release

| Field | Value |
|---|---|
| Runbook id | RB-KNOWLEDGE-RELEASE |
| Severity | Procedure (emergency withdrawal: SEV-2) |
| Primary owner role | Knowledge owner (with clinical safety lead and privacy counsel) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; the knowledge module (ingestion, sanitiser, snapshots, permission-filtered retrieval) exists and is tested offline on a SYNTHETIC corpus (`platform/src/knowledge`); no snapshot is approved. Approval scope `KNOWLEDGE_RELEASE` (PRQ-032) |

## Trigger and detection signals

New or changed public FAQ or approved runbook content; Salesforce Knowledge changes (export path UNKNOWN, VQ-SF-09); dashboard `<prefix>-knowledge`: oldest approved item age (`vsp_knowledge_freshness_age_seconds`) or items needing review (`vsp_knowledge_items_needing_review`); a wrong or unsafe answer traced to an article ([unsafe-output.md](unsafe-output.md)); an item quarantined with `KNOWLEDGE_HIDDEN_TAG_CHARACTERS` or an injection finding (`INJECTION_*`): treat the source as hostile and inform the knowledge owner and security operations.

## Immediate containment

Emergency withdrawal: mark the article version withdrawn (knowledge editor) so retrieval stops returning it; if the whole snapshot is suspect, roll back to the previous approved snapshot.

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

Retain the item metadata (owner, audience, permitted intent, jurisdiction, language, effective and expiry dates, sensitivity, approval, version), the sanitisation report, the snapshot digest and the approval record id.

## Step-by-step actions

1. Ingest through the controlled pipeline, never a blind paste of operational documents.
2. Sanitisation removes embedded instructions, links, attachments and executable content; review the sanitisation findings for every item:
   * **Quarantined** (never servable; listed by `reviewQueue()`): `KNOWLEDGE_EXECUTABLE_CONTENT` with the specific finding (scripts, embedded objects, event handlers, `javascript:` / `data:` URIs, code blocks, executable attachments); `KNOWLEDGE_HIDDEN_TAG_CHARACTERS` (text hidden in Unicode tag characters, whose decoded text is also checked for injection, VSP-KN-01); `KNOWLEDGE_SANITIZER_INPUT_TOO_LARGE` (VSP-KN-02); `KNOWLEDGE_EMPTY_AFTER_SANITIZE`; injection and dial-target findings (`INJECTION_*`, checked on the raw, entity-decoded and sanitised text); `KNOWLEDGE_PERSONAL_DATA_PATTERN`; approval, window and version problems; conflicts held for review.
   * **Stripped and recorded, not quarantined**: markup, links and raw URLs (`LINK_REMOVED`, `URL_REMOVED`, including bare domains on any TLD, decorated TLDs such as `evil.com-` and IP literals), invisible format characters (`INVISIBLE_CHARACTERS_REMOVED`); allowlisted links survive only as plain `host/path` (`LINK_REWRITTEN_ALLOWLISTED`). The approved link-domain list is BLOCKED on the knowledge owner and security.
   * Never release a quarantined item by deleting the finding or editing the sanitiser output; fix the source and ingest a new version. Dotted names such as `Node.js` are removed as domains by design; reword the article instead of widening the allowlist.
3. Apply approved source precedence; conflicting or expired items go to human review, not to callers.
4. Confirm no customer transcripts or therapy content are in the corpus; never build an embedding index of customer transcripts.
5. Build the snapshot; record its digest (pinned in the ReleaseManifest as `knowledgeSnapshotDigest`).
6. Knowledge owner, clinical safety lead (for anything near clinical boundaries) and privacy counsel review; the approver creates the `KNOWLEDGE_RELEASE` record.
7. Run the knowledge-grounding regression for affected intents; citation ids and exact article versions must accompany every policy-derived response.

## Verification

Retrieval returns only approved, unexpired items filtered by authorisation before and after search; every returned excerpt passes the current injection and sanitiser re-check (rows stored by an older sanitiser that fail it are dropped and logged with a reason code); regression passes.

## Communication roles

Knowledge owner; knowledge editor; clinical safety lead; privacy counsel; QA lead.

## Drill requirement

Release and emergency-withdrawal rehearsal in a non-production environment before pilot.
