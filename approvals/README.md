# Approval records

This directory holds **human approval records** that authorize pilot or production
exposure, PHI processing, billable execution, vendor sandbox integration and other
gated scopes (spec sections 5 and 16, invariants OPS-04 and OPS-05).

**There are no approval records here, and the coding agent cannot create them.**
An approval record is evidence that an accountable human (privacy counsel,
security leadership, clinical safety lead, finance, operations and the other roles
listed below) authorized a specific scope. Software, CI jobs and coding agents may
read and verify records; they never author, sign, extend or "fix" one. A record
that was not created and signed by its named approver is invalid, whatever its
content says.

## Who may create a record

| Scope | Typical approver role (`approver.role`) |
|---|---|
| `PHI_PROCESSING` | `privacy_counsel` |
| `SECURITY_REVIEW`, `STATIC_CREDENTIAL_EXCEPTION` | `security_leadership` |
| `CLINICAL_SCRIPTS` | `clinical_safety_lead` |
| `RETENTION_SCHEDULE` | `privacy_counsel` |
| `BILLABLE_TEST_EXECUTION` | `finance` |
| `PSTN_TEST_CALLS`, `PILOT_EXPOSURE`, `PRODUCTION_DEPLOYMENT` | `executive_sponsor` / `operations` / `sre_lead` |
| `VENDOR_SANDBOX_INTEGRATION` | `talkdesk_admin`, `salesforce_admin`, `identity_owner` (per integration) |
| `MODEL_VOICE_SELECTION`, `KNOWLEDGE_RELEASE`, `POLICY_RELEASE` | `qa_language_lead`, `clinical_safety_lead`, `security_leadership` as applicable |

The mapping above is a starting point for the organization's own RACI; the
organization decides who is accountable. The guard checks scope, environment,
validity window and signature; it does not decide whether the right person signed.
That is enforced by who controls the signing key.

## Format

One JSON file per record at the top level of this directory (`approvals/<anything>.json`),
validated strictly against [`schema/ApprovalRecord.schema.json`](schema/ApprovalRecord.schema.json)
(a copy of `schemas/protocol/ApprovalRecord.schema.json`, generated from
`platform/src/protocol/release.ts`). Unknown fields are rejected. Files larger than
64 KiB or that fail parsing are reported as `APPROVAL_RECORD_MALFORMED` /
`APPROVAL_RECORD_TOO_LARGE` and never count.

| Field | Meaning |
|---|---|
| `approvalId` | `apr_` + 8..64 base64url characters; unique across files (duplicates are a violation) |
| `approver.name`, `approver.role` | The accountable human and their role |
| `scope` | One `ApprovalScope` value |
| `scopeDetail` | Exact scope: tenant, SKU, region, feature, model/voice id, budget ceiling, integration, etc. |
| `environment` | `local`, `ci`, `sandbox`, `staging` or `production`; a record only counts in that environment |
| `grantedAt`, `expiresAt` | ISO-8601 UTC; the record is valid only in `[grantedAt, expiresAt)` |
| `evidenceRef` | Pointer to the reviewed evidence (ticket, signed document, evidence-pack path) |
| `signature` | Detached signature, `<algorithm>:<base64>` (see below); `null` = unsigned = invalid where approvals are required |

### Signature

The signature covers the UTF-8 bytes of the canonical JSON of the record **with
the `signature` property removed**: object keys sorted, no whitespace (see
`approvalSigningPayload` and `canonicalJson` in `platform/src`). Supported
algorithms (the tag must match the trusted key's type):

| Tag | Algorithm | AWS KMS signing algorithm |
|---|---|---|
| `ecdsa-p256-sha256` | ECDSA P-256, SHA-256, DER signature | `ECDSA_SHA_256` (key spec `ECC_NIST_P256`) |
| `rsa-pss-sha256` | RSASSA-PSS, SHA-256, salt length 32, modulus >= 2048 | `RSASSA_PSS_SHA_256` |
| `ed25519` | Ed25519 | (for non-KMS offline signing tools only) |

The trusted **public** key is configured by reference in
`platform/config/<env>.json` → `approvals.trustedSigningKeyRef`. In staging and
production this must be a KMS asymmetric key ARN (resolved with the documented
KMS `GetPublicKey` API); the private key never leaves KMS and signing rights are
granted only to approvers. Without a resolvable trusted key every record is
`UNVERIFIED_NO_TRUST_KEY`, which the guard treats as missing.

The KMS key, its key policy and the signing procedure are **BLOCKED** on security
leadership: no key exists yet and none may be created by the coding agent.

## What the guard requires

`platform/src/config/guard.ts` (`REQUIRED_APPROVALS_BY_ENVIRONMENT`):

- **production**: at least `PHI_PROCESSING`, `PRODUCTION_DEPLOYMENT`, `SECURITY_REVIEW`,
  `CLINICAL_SCRIPTS`, `RETENTION_SCHEDULE`, `MODEL_VOICE_SELECTION`, `POLICY_RELEASE`,
  `KNOWLEDGE_RELEASE`, plus any listed in the config, plus referenced records for
  static-credential exceptions, the model/voice pair, security-approved verification
  values and any session-binding exception.
- **staging**: at least `VENDOR_SANDBOX_INTEGRATION` and `SECURITY_REVIEW`.
- **sandbox**: every live adapter must reference (`adapters.<name>.integrationApprovalId`)
  a valid `VENDOR_SANDBOX_INTEGRATION` record; `PHI_PROCESSING` records for sandbox are
  rejected outright (PHI must be impossible in sandbox).
- **local / ci**: none; live adapters and PHI scopes are rejected.

A record counts only when it parses strictly, its signature verifies against the
trusted key, its `environment` equals the deployment environment, and the guard's
injected clock is inside `[grantedAt, expiresAt)`.

The current rejection of `platform/config/production.json` is captured in
`platform/src/config/__evidence__/production-guard-violations.json` (regenerated by
`platform/src/config/guard.test.ts`).
