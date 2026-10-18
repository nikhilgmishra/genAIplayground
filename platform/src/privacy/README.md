# platform/src/privacy: classification, redaction with quarantine, egress allowlist, consent gate

Status: **IMPLEMENTED_OFFLINE**. Pure TypeScript, unit and property tested. These
are engineering controls; they do not establish HIPAA compliance, de-identification
or production readiness.

Spec: section 6, DATA-01, DATA-02, DATA-03, OPS-04.

## What is implemented

### `classification.ts` (DATA-02)
`classifyArtifact()` maps an artifact to a `Classification`, a retention data class
and handling rules. Rules that no descriptor field can relax:
* raw audio and pre-redaction transcripts are always `PHI_RESTRICTED` / `RESTRICTED_QA_MEDIA`, even when a redacted derivative exists;
* a redacted transcript remains PHI-bearing (`PHI`): redaction is probabilistic and is not de-identification; a claimed de-identification is ignored (`DEIDENTIFICATION_NOT_ESTABLISHED`);
* failed / quarantined / unattempted redaction is treated as the restricted original and quarantined;
* derivation never lowers sensitivity; verification secrets are never persisted.

### `redaction.ts` + `redaction-service.ts` (DATA-01, DATA-02)
* `redactText()` tokenizes phone numbers (NANP, E.164, local), emails (incl. spoken "x at y dot z"), dates (ISO, numeric, month names), long digit runs, spoken and spaced digit sequences, SSN-like patterns, Luhn-valid card-like numbers and names supplied from trusted context. Output: `{ status, redacted, tokens, confidence, reasonCodes, deidentified: false, probabilistic: true }`. Tokens carry placeholder, type and an optional keyed HMAC digest (key from secret management), never the original value.
* Residual-risk heuristics (unlisted name after "my name is", identifier cue followed by a value, residual spoken digits, `@`) lower the confidence; below the threshold (engineering default 0.95, to be calibrated by privacy/security) or on any failure the result is `QUARANTINED` with `redacted: null`.
* `RedactionService.process()` routes a quarantined artifact only to a quarantine store whose destination the egress guard approves for `PHI_RESTRICTED`; otherwise nothing is sent anywhere. It never forwards content to a debugging vendor.

### `egress.ts` (DATA-01, OPS-04)
`EgressGuard` with an allowlist of destinations per payload classification:
* unknown destinations are denied for every class;
* PHI / PHI_RESTRICTED / FINANCIAL only to PHI-capable kinds (`PHI_PROCESSOR`, `SYSTEM_OF_RECORD`, `MODEL_ENDPOINT`, `RESTRICTED_MEDIA_STORE`) carrying both a BAA/coverage reference and an approval id;
* `VERIFICATION_SECRET` only to a `VERIFICATION_SERVICE` (AUTH-06);
* telemetry exporters, analytics sinks, developer tools, debugging vendors, support ticketing, audit sinks and public web: content-free classes only, regardless of configuration (violating configs are rejected at construction);
* URLs: https only (loopback http in local/ci), no userinfo, exact host[:port] match, no PHI-like pattern in path/query/fragment (opaque ids allowed);
* production rejects `local_fixture` destinations;
* `assertContentFreeTelemetry()` scans telemetry records for PHI-like values.

### `egress-startup.ts` (DATA-01, OPS-04): startup egress check, composed in `main/container.ts`
* `egressTargetsFor(config, telemetryExports)` lists every outbound destination the process is configured
  to use: each `PlatformConfig.adapters` entry (business systems, directories, notifications and
  telephony receive PHI; the OIDC / workforce IdP adapters receive content-free requests), the
  inbound-auth JWKS URI, the audit sink, and every telemetry / export destination the entry point
  composes (`ContainerOptions.telemetryExports`; none in the local composition).
* `checkStartupEgress` checks each one against the `EgressGuard` allowlist: live targets must declare an
  endpoint (`EGRESS_ENDPOINT_UNDECLARED`), PHI targets need a PHI-capable destination with coverage and
  approval, telemetry exports must resolve to a telemetry exporter / analytics sink
  (`EGRESS_NOT_A_TELEMETRY_DESTINATION`), and every URL rule of the guard applies. In-process LOCAL
  FIXTURE components have no network egress (`IN_PROCESS_FIXTURE`).
* Fail closed: the container refuses startup with `ConfigurationRejectedError` (`<REASON>@<config path>`)
  on any violation, before any database exists. Outside local/ci a missing policy is itself a violation
  (`EGRESS_POLICY_NOT_CONFIGURED@egress`) and the violations are added to the deployed-environment
  refusal reasons. In local/ci the default is `LOCAL_FIXTURE_EGRESS_POLICY`, which approves NO
  destination (the offline composition has no network egress).
* The container exposes `privacy.egress` (runtime guard, same policy, `vsp_egress_denied_total`),
  `privacy.redaction` (`RedactionService` over `InMemoryQuarantineStoreFixture`, for QA / transcript
  artifact handling; no transcript storage exists and none is added) and `privacy.egressReport`.
  Because the local policy approves nothing, a quarantined artifact is never sent anywhere
  (`QUARANTINE_STORE_NOT_APPROVED`): it stays in its original restricted location.

### `consent.ts` (DATA-03)
* Recording and automated processing follow approved consent state only: `UNKNOWN` is never consent; `NOT_REQUIRED` counts only with an approved jurisdiction rule. Without an approved rule the strictest behaviour applies.
* `gateProcessors()` blocks recorders without recording consent, transcription/model/synthesis/analytics without processing consent, transcript retention without both (conservative default), and every unapproved processor.
* `selectDisclosure()` returns the disclosure template id that truthfully matches what will run, the route (ask consent, continue, continue without recording, approved alternative: callback or person) and the processors that must stop. It never selects "not recorded" while any recording, transcription, model processing or transcript retention continues (`assertTruthfulDisclosure`). Declined recording without an approved alternative routes to a person.

### `patterns.ts`
Shared sensitive-pattern detectors (also used by knowledge ingestion and the egress guard).

## LOCAL FIXTURES

* `InMemoryQuarantineStoreFixture` (in-memory, not durable; SYNTHETIC data only).
* Tests use TEST-ONLY destinations on reserved `.invalid` hosts and loopback, and TEST-ONLY consent rules.

## BLOCKED (and the prerequisite needed)

| Item | Prerequisite |
|---|---|
| Real egress destinations and their coverage/approval references | Executed BAAs and service-specific coverage (PRQ-002, PRQ-038), observability export approval (PRQ-047) |
| `PlatformConfig.egress` section (config module owns the schema) | Interface change request; until then the entry point passes `ContainerOptions.egressPolicy` (local/ci default `LOCAL_FIXTURE_EGRESS_POLICY`; deployed environments refuse without one) |
| Endpoints for the S3 Object Lock audit sink and telemetry exporters in `PlatformConfig` | Config schema change (config owner); until then the audit sink reports `EGRESS_ENDPOINT_UNDECLARED@audit.sink` outside local/ci |
| Verifying `coverage.approvalId` against signed approval records | Approvals trust key (PRQ-023/PRQ-024) |
| Jurisdiction consent rules and disclosure wording | Privacy counsel rules per jurisdiction; template approval in the voice registry (PRQ-028) |
| Durable restricted quarantine store (e.g. S3 + KMS in a restricted account) | Infrastructure approval and PHI processing approval |
| Calibrating redaction confidence | Approved evaluation data and environment (PRQ-003, PRQ-012) |

## Known limitations

Pattern redaction misses identifiers that do not match the patterns (e.g. spelled-out
years, unlisted names without a cue, addresses) and over-redacts some benign text.
That is why the output is still classified PHI and why quarantine is the failure
mode.

## Tests

```
cd platform && npx vitest run src/privacy
```

## Requirement IDs enforced here

DATA-01 (no PHI to unapproved endpoints, developer tools or analytics sinks; every configured destination checked at startup), DATA-02 (raw audio stays sensitive; redaction failure quarantines), DATA-03 (consent-following processors and truthful disclosure), OPS-04 (fixture destinations refused in production), SPEC-6.redaction, SPEC-6.data-classes, SPEC-6.no-phi-in-urls.
