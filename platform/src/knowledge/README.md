# platform/src/knowledge: approved knowledge ingestion and permission-filtered retrieval

Status: **IMPLEMENTED_OFFLINE**. Tested against PGlite (PostgreSQL 17 in WASM with
pgvector 0.8) and against PGlite *without* pgvector. Nothing here has run against
Aurora, Salesforce Knowledge or a real embedding model. This module does not
establish HIPAA compliance or production readiness.

Spec: section 9 ("Approved knowledge and limited memory"), section 3 (retrieved
articles are untrusted input), OPS-06, SAFE-05.

## What is implemented

| File | Responsibility |
|---|---|
| `ports.ts` | `KnowledgeService` port. Added (backward compatible): optional `assurance` on `search()` input. |
| `schema.ts` | Strict zod schemas for `KnowledgeItemInput` and search input; digests; `citationIdFor()`. |
| `sanitize.ts` | Sanitizer for titles/bodies (HTML, scripts, styles, comments, embedded objects, event handlers, entities to a fixpoint, code blocks, inline code, images, attachments, executable file references, `data:`/`javascript:` URIs, markdown/HTML links, raw URLs and bare domains). Allowlisted links survive only as plain text `host/path`. Output invariants are property-tested. |
| `injection.ts` | Prompt-injection and dial-target detector (instruction overrides, role markers, persona switches, transfer/tool/secret directives, phone numbers, dial/press/extension instructions, `tel:`/`sip:` URIs) with Unicode/confusable folding. |
| `ingest.ts` | Controlled pipeline (`evaluateKnowledgeItem` pure + `runIngest` transactional). |
| `conflicts.ts` | Conflict detection and approved source precedence. |
| `snapshot.ts` | Pinned, append-only corpus snapshots `kb.<seq>.<digest12>` + sha256 digest (OPS-06). |
| `search.ts` | Retrieval: policy filters in a MATERIALIZED CTE before ranking, `ts_rank_cd` over `websearch_to_tsquery` (terms OR-ed), optional pgvector cosine similarity, TypeScript re-check before return. |
| `embedding.ts` | `LocalHashingEmbedder` (**LOCAL FIXTURE**, deterministic feature hashing, 256 dims). |
| `service.ts` | `KnowledgeServicePg` (ingest / search / snapshot / review queue / human release-reject of held items). |
| `corpus.ts` | Loader for the SYNTHETIC corpus in `/knowledge/corpus` (refused outside local/CI). |
| `testing.ts` | Test-only fixtures (item builder, in-transaction audit writer fixture). |
| `../../migrations/0500_knowledge.sql` | `knowledge_items`, `knowledge_snapshots`, conditional `knowledge_embeddings`, RLS, triggers. |

### Ingestion rules (per item)

1. Strict structural validation (unknown fields fail: `KNOWLEDGE_SCHEMA_INVALID`; missing/blank owner: `KNOWLEDGE_UNOWNED`).
2. Sanitize title and body. Executable or embedded content (`<script>`, `<iframe>`, event handlers, `javascript:`/`data:` URIs, fenced code, executable attachments) => quarantine `KNOWLEDGE_EXECUTABLE_CONTENT` (+ the specific finding). Formatting and links are stripped and recorded but do not quarantine.
3. Injection / dial-target detection on the raw input, the entity-decoded input **and** the sanitized output (an instruction hidden in a stripped HTML comment still quarantines). Knowledge can never carry a dial target (SAFE-05).
4. Personal-data patterns (email, SSN-like, Luhn card-like) => `KNOWLEDGE_PERSONAL_DATA_PATTERN` (not a blind paste of operational documents).
5. Policy: `APPROVED` with approver and time (not in the future); not expired; already effective; valid window; a `public` audience requires `PUBLIC` sensitivity.
6. Versions: a stored `(sourceId, version)` is immutable (application check + DB trigger `KNOWLEDGE_VERSION_IMMUTABLE`); versions older than the newest stored are `KNOWLEDGE_VERSION_STALE`; a live new version supersedes older ones; re-ingesting a live version as `REJECTED`/expired takes it out of service immediately; re-ingest of identical content is idempotent.
7. Conflicts: two different sources sharing an intent and an audience, same language and jurisdiction, overlapping windows and different content digests. With an **approved** precedence order (`{order, approvalRef}`) across different source systems, the lower-precedence item is held (`KNOWLEDGE_CONFLICT_LOWER_PRECEDENCE`); otherwise **both** are held (`KNOWLEDGE_CONFLICT_HELD_FOR_REVIEW`), including an already-live stored item. Holds are released only by `releaseHeld()`/`rejectHeld()` (MFA `knowledge_editor`).
8. Snapshot of the servable set; a new snapshot row only when the set changes. Optional audit event `knowledge.ingest` in the same transaction (audit failure => nothing ingested, OPS-01).

Structurally valid rejects are stored as quarantined review records (never servable; no embeddings); `reviewQueue()` lists metadata only (no bodies) and sets the catalogued gauges `vsp_knowledge_items_needing_review` / `vsp_knowledge_freshness_age_seconds`.

### Retrieval rules

* Runs as `app_runtime` with tenant RLS; the RLS policy itself exposes only servable rows.
* Filters (tenant, approved, not quarantined/held/superseded, effective window vs the supplied `now`, permitted intent, language with primary-subtag fallback, jurisdiction with country fallback for `US-XX`, audience) are applied in the `permitted` CTE **before** ranking and `LIMIT`.
* Audience: `audience: "public"` or `assurance: "A0"` => only `PUBLIC` items listing `public`. Otherwise public items plus items listing the caller's server-established role.
* Every returned row is re-checked in TypeScript (same predicate), its content digest is verified, and the excerpt is re-checked by the injection detector and sanitizer invariants; failures are dropped and logged with a reason code.
* Hits carry `citationId = kb_<sourceId>@v<version>` (exact version) and a bounded sanitized excerpt. Sensitive facts must come from structured tools, not from knowledge.
* Customer transcripts are never stored or embedded here.

## LOCAL FIXTURES

* `LocalHashingEmbedder` (`kind: "local_fixture"`). `KnowledgeServicePg` refuses it when `environment === "production"` (OPS-04).
* `/knowledge/corpus/**` is SYNTHETIC; its approvals are placeholders (`SYNTHETIC_FIXTURE_APPROVER`), not approval records. `loadLocalCorpus()` refuses sandbox/staging/production.
* `testing.ts` (`InTxAuditWriterFixture`, `knowledgeItemFixture`).

## BLOCKED (and the prerequisite needed)

| Item | Why | Prerequisite |
|---|---|---|
| Salesforce Knowledge export / sync adapter | No verified export API or sandbox in this environment; must not invent endpoints | Salesforce sandbox + documented export path (PRQ-032, VQ-SF-09) |
| Real embedding model | Model selection not approved; queries are caller utterances, so the endpoint needs BAA coverage (DATA-01) | MODEL_VOICE_SELECTION approval, PRQ-002 coverage; then a `live` `KnowledgeEmbedder` |
| Releasing a snapshot beyond local/CI | Requires accountable human approval of the corpus | KNOWLEDGE_RELEASE approval record (PRQ-032) |
| Approved source precedence | Which source wins is a business/policy decision | Knowledge owner approval reference for `precedence.approvalRef` |
| Approved link domains | Which hosts may appear in articles | Knowledge owner + security (config) |

## Known limitations

* Conflict detection is mechanical at the (intent, audience, language, jurisdiction) granularity; complementary articles for the same intent and audience are also held. That is conservative by design; a human releases them.
* The injection detector is heuristic (no spelled-out digits, no deep obfuscation such as letter-spaced words). Retrieval therefore treats excerpts as untrusted data, and transfers use allowlisted destinations only.
* The local embedder is lexical; it does not provide semantic recall.
* `releaseHeld()`/`rejectHeld()` execute as `app_worker` with the staff id in the RLS context (the console module owns the staff-facing endpoint).

## Tests

```
cd platform && npx vitest run src/knowledge
```

Files: `sanitize.test.ts` (unit + fast-check properties: output never contains `<script`, `javascript:`, a scheme URL, `www.` or a non-allowlisted domain; idempotence), `ingest.test.ts`, `search.test.ts` (incl. no-pgvector migration), `conflicts.test.ts` (incl. embedder).

## Requirement IDs enforced here

SPEC-9.ingestion, SPEC-9.sanitize, SPEC-9.conflict, SPEC-9.retrieval, SAFE-05 (no dial targets from documents), OPS-06 (pinned versions/snapshots), OPS-04 (fixture refusal), OPS-01 (audited ingestion), AUTH-01 (A0 public only), AUTH-02 (RLS).
