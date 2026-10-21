# platform/src/protocol — contract registry

One maintained zod source for every protocol contract (follow-on prompt section 4). The JSON Schemas
in `schemas/protocol/`, the approver copy in `approvals/schema/`, the console OpenAPI in
`schemas/openapi/console.openapi.json` and the TypeScript types (`z.infer`) are all generated from it.

```
pnpm --filter @vsp/platform schemas:gen     # write every generated file
pnpm --filter @vsp/platform schemas:check   # CI drift gate: differs, missing or stale file -> exit 1
pnpm --filter @vsp/platform exec vitest run src/protocol
```

## Files

| File | Contracts | Owner after phase B |
|---|---|---|
| `common.ts` | primitives: opaque ids, UTC instants, `BusinessTimeZone`, `LocalDate`, `Money` (ISO 4217, integer minor units), `PageRequest`/`PageInfo`/`paged()`, `TimeRange`/`timeRange()`, the common `envelope()`, `IssueOutcome` + `IssueOutcomeRecord`, `ConsentValue` (four wire values) + `ConsentValueV2` (+ `EXPIRED`) + `ConsentDimension` + `ConsentProfile`, `DisclosureClassification`, `MAX_CLOCK_SKEW_MS`, the AUTH-03 proposal scan, `ProcessingPurpose`, `ProcessingBasisKind`, `Jurisdiction`, `SoftwareStatus` / `EnvironmentStatus` / `QualificationResult` / `CapabilityStatus` | WP-22 then WP-25 |
| `auth.ts` | `AuthContext` (+ `processingBasis`, `consentProfile`, `dataClassification` capped below `VERIFICATION_SECRET`), `ProcessingBasis` (approval and jurisdiction rules), `IntegrationChannel` | WP-05 |
| `call-binding.ts` | `CallBinding`, `checkBinding()` | WP-11 |
| `media.ts` | `TurnEnvelope`, `CarrierEvent`, `SpeechPlan` (template placeholders, no literal values in protected wording), `AudioReleaseReceipt`, `receiptPlanIssues()` | WP-14 |
| `context-facts.ts` | `ContextFact`, `SourceWatermark` | WP-18 |
| `context-snapshot.ts` | `ContextSnapshot` | WP-24 |
| `identity-link.ts` | `IdentityLink`, `PersonRoleAssignment` | WP-19 |
| `knowledge.ts` | `KnowledgeCitation` | WP-20 |
| `models.ts` | `ModelInvocation`, `ModelDecision` | WP-09 |
| `actions.ts` | `PreparedAction` (wire) and `PreparedActionV2`, `ConfirmationReceipt` + `checkConfirmationReceipt()`, `ActionGrant` + `checkActionGrant()`, `CommitReceipt` | WP-25 |
| `effects.ts` | `EffectVerification`, `CaseLink` | WP-25 |
| `support.ts` | `SupportRequest` (+ `caseLinks`, `issueOutcome`), `HandoffPackage`, `TransferStateV2` | WP-28 then WP-29 |
| `workflow.ts` | `WorkflowEvent`, `HumanTask`, `WorkflowStateNameV2` | WP-26 |
| `connector.ts` | `ConnectorProfile`, `CapabilityEvidence` | WP-06 then WP-32 |
| `tenant.ts` | `TenantConfig` | WP-31 |
| `activation.ts` | `ActivationReport`, `ActivationRecord` | WP-31 |
| `improvement.ts` | `ChangeProposal`, `CanarySpec` | WP-36 |
| `review.ts` | `ReviewRecord`, `DatasetItem` | WP-35 |
| `plan.ts` | `LongHorizonPlan` | WP-30 |
| `evaluation.ts` | `ScenarioDefinition`, `EvaluationResult` (+ follow-on fields), `ExecutionMode` | WP-34 |
| `release.ts` | `ApprovalRecord`, `ReleaseManifest` (+ `statusAxes`, `capabilities`), `StatusAxes` | WP-40 (phase G) |
| `audit.ts` | `AuditEvent` (+ `causationId`), `AuditManifest` (+ signature) | WP-04 |
| `tool-envelope.ts` | `ToolRequestV2`, `ToolResultV2`, `toolResultV2()` (typed per-tool results), `ToolResultFreshness` | registry group (WP-07 in B, then each phase's integration package) |
| `tools.ts`, `registry.ts`, `index.ts` | original wire contracts and registry | registry group (WP-07 in B) |
| `followon.ts` | `FOLLOWON_CONTRACTS` (the 34 descriptors with their common-field maps), `CONTRACT_ALIASES`, `FOLLOWON_SCHEMAS` | registry group (WP-07 in B, then each phase's integration package) |
| `common-fields.ts` | the common-field model (FO-04-42): `COMMON_FIELDS`, the prompt phrase map, contract traits and the fields each trait makes relevant, property-name aliases | registry group |
| `registry-check.ts` | strictness / boundedness / version / common-field (relevance, presence, shape, alias) checks used by `registry.test.ts` | registry group |
| `digests.ts` | Node-only digests: `sealSpeechPlan`, `verifySpeechPlanDigest`, connector and tenant config digests | registry group |
| `console-openapi.ts` | renders the console OpenAPI from `platform/src/console-api/schemas.ts` + `contract.ts` (generator only) | registry group |
| `generate-schemas.ts` | the generator and `--check` drift gate | registry group |

## Rules every contract follows

1. **Strict.** Every object is `z.strictObject` (JSON Schema `additionalProperties: false` on every object
   node). Unknown fields fail.
2. **Bounded.** Every string has a length bound, pattern, enum or format; every array a `maxItems`; every
   number a minimum and maximum; every map a key-count bound (`.meta({ maxProperties })` plus a refine).
   `registry-check.ts` enforces this over the generated JSON Schema of all 34 contracts.
3. **Versioned.** Each follow-on contract pins `schemaVersion: "<contract>.v<n>"` (ReleaseManifest keeps
   `manifestVersion`); each generated file carries `x-protocol-version` and `x-contract-version`. The
   original contracts still being produced by other packages (AuthContext, CommitReceipt, SupportRequest,
   WorkflowEvent, HandoffPackage, ScenarioDefinition, EvaluationResult, ApprovalRecord) carry the field
   **optionally** until their producer sets it (`optionalUntilAdoption`, with the adoption owner); a record
   without it is the v1 contract.
4. **Common fields where relevant (FO-04-42).** `common-fields.ts` models all seventeen common fields of the
   prompt's list, including policy/config/source `versions`, source `provenance` and `outcome`. Relevance is
   decided by each contract's domain traits there (tenant data, inside a call, fenced by the session
   generation, expiring, derived from a source, recording an outcome, ...), not by the descriptor. The
   registry test requires every descriptor to map exactly the relevant fields, every mapped property to be
   present, required (or optional until adoption) and of the field's shape, and every property named like a
   common field (`tenantId`, `callId`, `expiresAt`, `dataClass`, ...) to be relevant under the traits. The map
   is published in each generated file as `x-common-fields`. `envelope(version, required, nullable)` builds
   the envelope ids in the protocol's camelCase convention (`ENVELOPE_SPEC_NAMES`).
5. **Server-established fields never come from proposals (AUTH-03).** `ModelDecision.arguments` and
   `ToolRequestV2.arguments` refuse, at any depth:
   * every name in `PROPOSAL_FORBIDDEN_FIELDS` (every identity, authority and consent field of
     `AuthContext` plus the trusted envelope fields) and the prototype keys, in any spelling (compared
     case-insensitively with `_` and `-` removed: `tenant_id`, `TenantId`, `ASSURANCE`);
   * every key one of whose WORDS names a concept of `PROPOSAL_FORBIDDEN_CONCEPTS` (actor, subject,
     organization, role, assurance, consent, scope, delegation, tenant, call, session, verification and
     authentication state, grant, risk, revocation, interaction, causation, classification, basis, ...):
     `subject`, `consentRecording`, `consent_automated_processing`, `callerRole`, `isVerified`. A concept
     also matches as the start or end of a glued word (`roles`, `delegated`, `recordingconsent`), except
     for the listed ordinary-word exclusions (`callback`, `recall`, `factor`, `telescope`, ...).
   The only way past the scan is a reviewed `PROPOSAL_KEY_EXEMPTIONS` entry with its exact values:
   `concernSubject` with `SELF`/`THIRD_PARTY`/`UNKNOWN`, the safety tool's argument (SAFE-02). The tests
   tie the forbidden list to `AuthContext`, the concept list to an independent copy and the exemption to
   the tool catalogue, and check that every catalogue argument still passes. The scan runs on the RAW value
   before zod parses the record (zod drops an own `__proto__` key silently), so a polluted payload is
   refused by the contract itself; `safeParseUntrusted(schema, raw)` applies the same scan to any other
   untrusted value.
6. **Opaque identifiers only**, never names, phone numbers or dates of birth; a phone-shaped carrier
   reference, and a `tel:`/`sip:`/`sips:` party URI that would carry it, is refused (`CarrierInteractionRef`); model-cited `sourceRefs` are opaque ids or citation ids.
7. **UTC instants** (`Z`, no offset) plus an explicit IANA business timezone for business dates
   (`toBusinessDate`, `tenantBusinessDate`). **Money** in every protocol contract is `Money` (ISO 4217 code,
   integer minor units). Outside the protocol, the billing tool output (`gateway/tools/billing.ts`, registry
   group) still reports a literal `USD` with `balanceMinor` until its owner adopts `Money`.
8. **Two status axes are consistent (OPS-03).** `statusAxesIssues` applies to `CapabilityStatus`,
   `StatusAxes` and `ActivationRecord`: PASS and verified software need evidence, and an environment at or
   above `VERIFIED_SANDBOX` needs implemented software, evidence and a PASS qualification. A legacy
   `ReleaseStatus` label maps to at most `CONFIGURED` (`statusAxesFromLegacy`); the label stays in
   `legacyReleaseStatus`.
9. **Every boundary rule is tested.** Each rule reports a stable code; `rules.test.ts` holds one adversarial
   case per rule and a coverage test that scans these sources for every code a rule can emit, so a rule
   without a test fails the suite.

## Additive changes to the original contracts

The original wire contracts are consumed by modules other packages own, and some of them are embedded
in generated artifacts of the registry group (`schemas/openapi/gateway.openapi.json`,
`schemas/tools/catalog.json`). Their follow-on changes are therefore additive and backward compatible:

* New envelope fields on existing contracts are **optional until the producer adopts them**
  (`optionalUntilAdoption` in the descriptor names the field and `adoptionOwner` the package). Absent
  optional fields are absent after parsing, so audit hash chains, prepared-action digests and approval
  signatures of existing records are unchanged.
* Enum extensions that would break consumers owned elsewhere are delivered as separate enums with the
  exact values, and the owners switch the original field when they adopt them:

  | Delivered | Replaces | Adopted by |
  |---|---|---|
  | `TransferStateV2` (+ `RECEIVER_DECLINED`) | `TransferState` in `TransferRecord` and the console contract | WP-28 with the console group owner |
  | `WorkflowStateNameV2` (+ `INVESTIGATING`, `VERIFYING_EFFECT`, `EXPIRED`) | `WorkflowStateName` in `WorkflowEvent`, the engine and the console contract | WP-26 with the console group owner |
  | `IntegrationChannel` (+ `conversation_runtime`) | `IntegrationIdentity.channel` | WP-05 (gateway/auth.ts credentials, session channel allowlists) |
  | `ExecutionMode` (+ `local_emulator`, `model_text`, `audio`) | `EvaluationResult.executionMode` (still the original four) | WP-01 adapts `evaluation/types.ts` and `aggregate.ts`; WP-34 (owner of `protocol/evaluation.ts` after phase B) widens the field |
  | `IssueOutcome` + `IssueOutcomeRecord` (`LEGACY_OUTCOME_TO_ISSUE_OUTCOME`) | per-issue use of `Outcome` | WP-25 / WP-30 |
  | `ConsentValueV2` (+ `EXPIRED`; used by `ConsentDimensionState` / `ConsentProfile`) | `ConsentValue` in `business/recheck.ts` (registry port and snapshot parse), `privacy/consent.ts`, `evaluation/runner.ts` and `ConsentState` | WP-05 / WP-22, each together with an explicit `EXPIRED` denial |
  | `ToolRequestV2`, `ToolResultV2` | `ToolRequest`, `ToolResult` on the gateway wire | WP-07 (pipeline, routes, OpenAPI regeneration) |
  | `PreparedActionV2` (+ `schemaVersion`, `causationId`) | `PreparedAction`, whose digest covers every declared field (`actions/digest.ts` DIGEST_FIELDS) | WP-25 (digest field list and ledger row persist both fields) |
  | `caseLinks`, `caseLinksOf()` | `SupportRequest.salesforceCaseId` (deprecated) | WP-29 |
  | `statusAxes`, `capabilities`, `statusAxesFromLegacy()` | single-axis `ReleaseManifest.status` | WP-40 |

  Widening the original enums in place was probed (scratch copy, `tsc --noEmit`): `TransferState` +
  `RECEIVER_DECLINED` breaks `console-api/plugin.ts` and `console-api/read-models.ts`; `WorkflowStateName`
  + three states breaks `console-api/plugin.ts` (3 sites) and the exhaustive switch in
  `workflows/outcome.ts`; `IntegrationIdentity.channel` + `conversation_runtime` breaks `gateway/auth.ts`,
  `identity/session-service.ts` and `identity/session-store.ts`; `EvaluationResult.executionMode` widened
  breaks `evaluation/aggregate.ts`. Those files belong to other packages, so the exact values ship as the
  V2 enums above and the owners switch over.
* `ConsentValue` keeps its original four values. It was widened with `EXPIRED` in an earlier round, and a
  journey probe showed the effect: an `EXPIRED` consent-registry value then passed `business/recheck.ts`
  `consentFor()`, and the recheck failed one step later with an unaudited `RECHECK_POLICY_INPUT_INVALID`
  validation error instead of its audited denial. With the four-value enum, the registry port refuses
  `EXPIRED` and a registry that returns it takes the parse-failure branch: the `workflow.recheck.denied`
  audit event and `POLICY_CHANGED_PENDING_ACTION` with `CONSENT_NOT_ESTABLISHED` (re-run of the probe in
  the WP-02 report). The value set with `EXPIRED` is `ConsentValueV2`; a consumer adopts it only together
  with its own explicit `EXPIRED` denial.
* `SpeechPlan` `TEMPLATE_EXACT.text` is the approved template wording with `{slot}` placeholders (the voice
  catalogue's syntax), not rendered text: the placeholders must be exactly `slotNames`, and in a
  protected-fact class (`IDENTITY`, `FINANCIAL_FACT`, `COMMITMENT`, `PROTECTED_FACT`) the literal wording
  states no value (no digit, currency symbol or spelled number of the plan's language, en and es). Every
  protected-class template of `platform/src/voice/templates` satisfies this (tested).
* An `AudioReleaseReceipt` for clip audio is always a `fallback_clip` source (naming the plan it stood in
  for, if any); a plan-sourced receipt is never rendered by the clip renderer. `receiptPlanIssues(receipt,
  plan)` is the cross-check the release guard and audit verification (WP-14) run against the named plan.
* `checkConfirmationReceipt` / `receiptConfirms` take the prepared action's tenant, session reference,
  generation, actor, preparation time and expiry; `checkActionGrant` takes the use's subject, actor,
  purpose and parameters and enforces the declared parameter bounds. Neither has a producer yet (WP-25).
* `console-openapi.ts` (generator only) imports `platform/src/console-api`. A module-boundary allowlist that
  lets untrusted code import `platform/src/protocol` must exclude `console-openapi.ts` and
  `generate-schemas.ts` (WP-06).
* `FOLLOWON_SCHEMAS` is rendered next to the original `PROTOCOL_SCHEMAS`; a name in both must be the same
  zod object. Merging `FOLLOWON_SCHEMAS` into `PROTOCOL_SCHEMAS` and re-exporting the new modules from
  `index.ts` is the registry group owner's integration step (until then import from `followon.ts` or the
  contract file).

## Producer status (`FOLLOWON_CONTRACTS[*].producer`)

* `IN_USE`: the producing component parses this exact schema today (the registry test reads the source
  file and checks it).
* `LEGACY_WIRE_IN_USE`: the producer parses the original wire schema; the follow-on version is adopted
  by `adoptionOwner`.
* `PLANNED`: no producer exists yet; `adoptionOwner` builds it.

## Adding a contract

1. Define it in its owner's file with `envelope()`, strict objects and bounds; export its
   `<NAME>_SCHEMA_VERSION`.
2. Add a descriptor to `FOLLOWON_CONTRACTS` (or a supporting schema to `FOLLOWON_SUPPORTING_SCHEMAS`).
3. `pnpm --filter @vsp/platform schemas:gen`, then run `vitest run src/protocol`.
