# knowledge/: SYNTHETIC local knowledge corpus

**SYNTHETIC LOCAL FIXTURE.** Nothing in this directory is approved company policy,
a jurisdiction-approved disclosure, a clinical script, or reviewed by legal,
clinical or language reviewers. The approval fields inside each item are
synthetic placeholders (`SYNTHETIC_FIXTURE_APPROVER`), not approval records. The
loader (`platform/src/knowledge/corpus.ts`) refuses this corpus outside local and
CI environments.

The real corpus comes from Salesforce Knowledge and approved runbooks through the
ingestion pipeline in `platform/src/knowledge` and needs a KNOWLEDGE_RELEASE
approval before use beyond local/CI (prerequisite PRQ-032). That path is BLOCKED
until a Salesforce sandbox and documented export path exist.

## Layout

| Path | Contents |
|---|---|
| `corpus/approved/*.json` | 20 SYNTHETIC items that pass the pipeline: portal sign-in guidance without credential reset, reaching a person (English and an unreviewed Spanish sample), hosted payment page, appointment rescheduling, statement terms, claim status meaning (not a guarantee), provider onboarding documents, remittance status (provider audience, INTERNAL), partner intake (partner audience, INTERNAL), complaints, accessibility and interpreter requests, recording/processing explainer, why we verify, support references, appointment lookup (INTERNAL), two runbooks (billing dispute review, credentialing boundary), representative access, notification messages |
| `corpus/adversarial/*.json` | Deliberately bad items for tests: prompt injection, embedded dial target, instruction hidden in an HTML comment, executable content, pasted personal data, expired, unapproved, unowned, not yet effective, and a conflicting pair |

## File format

```json
{
  "$fixture": "SYNTHETIC LOCAL FIXTURE - ...",
  "item": { "...": "KnowledgeItemInput (platform/src/knowledge/ports.ts)" }
}
```

Every file must start its `$fixture` label with `SYNTHETIC LOCAL FIXTURE`; the
loader rejects unlabelled files. `item` is validated strictly by the pipeline
(unknown fields fail).

## Writing guidance (what the pipeline rejects)

* No phone numbers, dial/press/extension instructions or `tel:`/`sip:` links: transfers use allowlisted destinations from trusted configuration only (SAFE-05).
* No instructions to the model ("ignore previous instructions", "system:", "you are now", "transfer the caller to", "call the ... tool", "reveal ...").
* No HTML scripts, embedded objects, code blocks, executable attachments or `data:`/`javascript:` links. Ordinary links are reduced to their text; links to allowlisted hosts (locally `portal.synthetic-health.test`, `pay.synthetic-health.test`) remain as plain text `host/path`.
* No personal data (emails, SSN-like or card-like numbers).
* One item per (intent, audience, language, jurisdiction); otherwise both items are held as a conflict for human review.
* Every item needs an owner, approval, effective date and (where applicable) expiry; expired, unapproved and not-yet-effective items are quarantined.

## How it is used

```
cd platform && npx vitest run src/knowledge
```
