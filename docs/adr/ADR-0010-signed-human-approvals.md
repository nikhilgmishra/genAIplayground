# ADR-0010 Approvals are signed human records; the coding agent cannot fabricate them; the production guard enforces them

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Trusted signing key: **BLOCKED** (PRQ-023). Every approval record: **Pending human approval** |
| Date | 2026-10-17 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Security leadership (signing key custody); each scope's accountable approver |
| Related prerequisites | PRQ-023, PRQ-024 |

## Context

Spec execution order step 7: human approvals authorise pilot or production exposure; the coding
agent cannot sign for privacy counsel, security, clinical leadership, finance or operations.
Spec section 16: an approval record identifies approver, role, scope, time, expiry and
evidence; the coding agent cannot fabricate it. OPS-04: production refuses fixture adapters and
missing mandatory approvals. OPS-05: no paid tests, PHI access or production changes without
scoped authorisation.

## Decision

1. An approval is an `ApprovalRecord` (`platform/src/protocol/release.ts`): approver name and
   role, `ApprovalScope`, precise scope detail (tenant, SKU, region, feature, model, budget
   ceiling), environment, validity window, evidence reference and a detached signature over
   the canonical JSON. Records live in `approvals/` ([`../../approvals/README.md`](../../approvals/README.md)).
2. Signatures are verified against a trusted key reference (KMS) held by security leadership.
   The coding agent, CI jobs and software may read and verify records; they never author,
   sign, extend or repair one. An unsigned record is invalid where approvals are required.
3. The configuration guard (`platform/src/config`) rejects, for production: fixture adapters,
   missing credentials references, unapproved models, unknown policy versions, permissive CORS,
   disabled audit, missing approvals for the required scopes, PHI endpoints without a valid
   `PHI_PROCESSING` approval, and an absent or invalid trusted key. Sandbox live adapters need a
   `VENDOR_SANDBOX_INTEGRATION` approval referenced by id.
4. The `ReleaseManifest` lists present approvals and `missingApprovals`; missing evidence is
   never PASS (OPS-03).
5. The prerequisite register ([`../prerequisites.yaml`](../prerequisites.yaml)) records status only;
   `APPROVED` there must cite an `apr_…` approval record id.

## Consequences

* No environment beyond local and CI can start with live adapters until humans create the key
  and records; offline work is unaffected.
* Who may sign is enforced by key custody, not by the guard; the guard checks scope,
  environment, validity window and signature.
* Approval records are evidence and need their own retention class (PRQ-025).

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| Approval flags in configuration files | Anyone with repository write access could set them, including the coding agent |
| Approvals tracked only in a ticketing system | Not machine-verifiable at startup |
| CI-generated approvals after tests pass | Tests are evidence, not authorisation (spec section 16) |

## Linked requirements

OPS-03, OPS-04, OPS-05, SPEC-16 (approval records, production configuration rejection).

## Revisit when

Security leadership creates the signing key (PRQ-023) or the organisation adopts a different
approval system of record that can be verified at startup.
