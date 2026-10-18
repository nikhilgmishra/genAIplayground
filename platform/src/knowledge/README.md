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
| `sanitize.ts` | Sanitizer for titles/bodies (HTML, scripts, styles, comments, embedded objects, event handlers, entities to a fixpoint, code blocks, inline code, images, attachments, executable file references, `data:`/`javascript:` URIs, markdown/HTML links, raw URLs, bare domains on any TLD, including TLDs followed by decoration such as `-`, `_`, digits or combining marks, and IPv4/IPv6 literals). Allowlisted links survive only as plain text `host/path` (no port, query, fragment or dotted path segment). Inputs longer than `MAX_SANITIZE_INPUT_CHARS` (2 x `MAX_BODY_CHARS`), before or after NFKC, fail closed with the quarantine finding `SANITIZER_INPUT_TOO_LARGE`. Output invariants are property-tested with an independent oracle (VSP-KN-01). Trailing punctuation and slash runs are trimmed by backward scans, not `[...]+$` regexes, which are O(n^2) on long runs (VSP-KN-02). |
| `host-literals.ts` | Detection of bare domains, IPv4 and IPv6 literals with their port and path (VSP-KN-01). A domain is a dotted run (labels joined by runs of `.`, U+3002, U+FF0E or U+FF61) in which some later label, with combining marks deleted, *begins* with 2-63 letters: decoration after the letters (`evil.com-/reset`, `evil.com_`, `evil.com1`, `evil.co\u0332m`, `xn--` A-labels) does not hide the TLD. IPv4: four or more numeric labels (decimal or hex, optionally decorated with `-`/`_`). IPv6: `::` or eight groups, optionally bracketed. Linear time: literals inside an earlier literal's path are still reported (the re-check needs them), so the path end is memoized instead of rescanned per literal (VSP-KN-02). Internal. |
| `markup.ts` | Linear-time element pairing (`replaceElements`) and `<tag ...>` replacement (`replaceTags`) with exactly the semantics of the former lazy cross-tag regexes, which backtracked in O(n^2)/O(n^3) on unterminated markup (VSP-KN-02). Internal. |
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
2. Sanitize title and body. Executable or embedded content (`<script>`, `<iframe>`, event handlers, `javascript:`/`data:` URIs, fenced code, executable attachments) => quarantine `KNOWLEDGE_EXECUTABLE_CONTENT` (+ the specific finding). An input the sanitizer refuses as too large => quarantine `KNOWLEDGE_SANITIZER_INPUT_TOO_LARGE` (+ `KNOWLEDGE_EMPTY_AFTER_SANITIZE`). Formatting and links (including bare domains and IP literals) are stripped and recorded but do not quarantine.
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
* Every returned row is re-checked in TypeScript (same predicate), its content digest is verified, and the excerpt is re-checked by the injection detector and sanitizer invariants (including bare domains on any TLD and IP literals, so rows stored by an older sanitizer are dropped too); failures are dropped and logged with a reason code.
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

* Invisible characters (VSP-KN-01, round 3): every Unicode format character (`\p{Cf}`)
  and default-ignorable code point is deleted before matching (`stripInvisible` in
  `platform/src/privacy/patterns.ts`, shared with injection detection, search-query
  normalization and PHI redaction), so they can no longer split a host. Unicode tag
  characters (U+E0000-E007F) additionally quarantine the item (`HIDDEN_TAG_CHARACTERS`)
  and their decoded text is run through injection detection. Tests:
  `src/knowledge/sanitize.invisible.test.ts`.
* Conflict detection is mechanical at the (intent, audience, language, jurisdiction) granularity; complementary articles for the same intent and audience are also held. That is conservative by design; a human releases them.
* The injection detector is heuristic (no spelled-out digits, no deep obfuscation such as letter-spaced words). Retrieval therefore treats excerpts as untrusted data, and transfers use allowlisted destinations only.
* Domain detection is deliberately broad (any dotted run in which a later label begins with 2-63 letters, whatever follows them): dotted identifiers such as `Node.js`, `statement.pdf` or `build.rc1`, a sentence typed without a space after its full stop, and words joined by an ellipsis with no space (`wait...what`) are removed as domains (STRIP-level `URL_REMOVED`, not quarantine). Because U+3002 is an IDNA label separator, CJK prose joined by an ideographic full stop with no following space is removed the same way; CJK is not a supported knowledge language today.
* Not detected: spelled-out or spaced addresses ("evil dot com", `evil . com`, "hxxps colon slash slash"); bare decimal-integer IPv4 (`3405803783`) and two- or three-part shorthand IPv4 (`127.1`); and TLD labels that *start* with `-`, `_` or a digit (`evil.-com`, `evil.1com`), because treating that as decoration would also remove `U.S.-based`, `9.30am` and `2.5GB`. Look-alike separators that are not IDNA label separators (U+00B7 middle dot, U+06D4 Arabic full stop: `evil\u00b7com`) are not treated as dots. A character that is neither a separator nor a label character after the TLD (U+2010 hyphen) ends the run, so `evil.com` is still removed from `evil.com\u2010/x`. The same character *before* the dot (`evil\u2010.com`) also ends the run, so that form is left as text; it is not a resolvable hostname as written. Long digit runs are covered by the dial-target detector.
* Sanitization has no wall-clock deadline (its output feeds content digests and must stay deterministic). Time is bounded instead by linear-time patterns plus the input cap. Measured on a developer machine (best of three): the slowest adversarial units (repeated markdown image/link openers) take about 65-100 ms at 20 000 characters and about 135 ms at 40 000; host+path units (`a.bc/`, combining-mark `a.bc/`, IPv4/IPv6 with paths) take about 5-15 ms at 40 000 (they took up to about 1.1 s before the VSP-KN-02 round-2 fix); `evaluateKnowledgeItem` on a schema-maximum body that NFKC-expands to 35 001 characters takes about 10 ms (about 760-850 ms before). Tests enforce a strict 100 ms budget for host+path units at 20 000 and 40 000 characters and for punctuation-run, slash-run and NFKC-expanding bodies of up to about 40 000 characters after NFKC, 50 ms for `hostLiterals` alone at 20 000 and 40 000 characters, and a coarse 1.5 s budget for the markup units. The per-start work of the capped link patterns is bounded by their 2 000-character target cap, so the constant factor, not the growth, dominates their time.
* The local embedder is lexical; it does not provide semantic recall.
* `releaseHeld()`/`rejectHeld()` execute as `app_worker` with the staff id in the RLS context (the console module owns the staff-facing endpoint).

## Tests

```
cd platform && npx vitest run src/knowledge
```

Files: `sanitize.test.ts` (unit + fast-check properties: output never contains `<script`, `javascript:`, a scheme URL, `www.` or a non-allowlisted domain; idempotence), `sanitize.adversarial.test.ts` (VSP-KN-01: generated domains on arbitrary TLDs, decorated TLDs (trailing `-`/`_`/digits/combining marks, fullwidth and small dashes, marks inside the TLD, repeated separators), IDNA separators, IPv4 literals (decorated too) and IPv6 literals never survive, checked against an independent oracle (NFKD, marks deleted, separators folded), end to end through ingest and search; VSP-KN-02: adversarial markup at the schema maximum within a time budget, host+path and punctuation-run units at 20 000 and 40 000 characters within a strict budget, fast-check compositions, input cap and NFKC expansion), `host-literals.test.ts` (VSP-KN-01 classification table; VSP-KN-02: differential property proving the memoized port/path end equals the former sticky regex, strict timing at 20 000, 40 000 and 160 000 characters), `markup.test.ts` (VSP-KN-02: differential properties proving the linear matchers equal the former regexes; linear-time checks at 40 000 chars), `ingest.test.ts`, `search.test.ts` (incl. no-pgvector migration and the VSP-KN-01 stored-row re-check, decorated TLDs included), `conflicts.test.ts` (incl. embedder).

## Requirement IDs enforced here

SPEC-9.ingestion, SPEC-9.sanitize, SPEC-9.conflict, SPEC-9.retrieval, SAFE-05 (no dial targets from documents), OPS-06 (pinned versions/snapshots), OPS-04 (fixture refusal), OPS-01 (audited ingestion), AUTH-01 (A0 public only), AUTH-02 (RLS).
SPEC-14.threat-model: malicious URLs (VSP-KN-01: no bare domain or IP literal outside the allowlist) and denial of service through sanitizer backtracking or quadratic host/path scans (VSP-KN-02).
