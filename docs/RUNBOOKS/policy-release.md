# RB-POLICY-RELEASE Policy bundle release

| Field | Value |
|---|---|
| Runbook id | RB-POLICY-RELEASE |
| Severity | Procedure |
| Primary owner role | Policy approver (with security leadership) |
| Last drilled | NEVER (not yet run) |
| Status | Draft; policy module and `scripts/policy.sh` under implementation. Approval scope `POLICY_RELEASE` (PRQ-031) |

## Trigger and detection signals

A change to Rego in `policy/`, to tool permissions or minimum assurance in the tool catalogue, to relationship types, or to field masks; or an emergency rollback from [authentication-bypass.md](authentication-bypass.md).

## Immediate containment

Emergency path: roll back to the last approved bundle digest (deployment operator); policy changes have no hot reload in production ([ADR-0002](../adr/ADR-0002-opa-wasm-in-process.md)).

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

Retain the change record, golden-probe report (before and after), expansion-gate result, bundle digest and version, approval record id and release manifest.

## Step-by-step actions

1. Author the change with new or updated golden decision probes: for every allowed case, adjacent denials (unrelated subject, expired relationship, below assurance, wrong tenant, revoked session).
2. Run `pnpm policy:test` (PLANNED: `opa test` with the pinned OPA 1.21.0 from `bash scripts/fetch-tools.sh`) and the WASM parity tests in vitest.
3. Run the **expansion gate**: any probe changing from deny to allow, any widened field mask or removed obligation fails unless listed in the change record.
4. Build the bundle (`pnpm policy:build`, PLANNED) and record its sha256 and version.
5. Policy approver and security leadership review the change record, probe diff and permission-matrix update ([`../security/permission-matrix.md`](../security/permission-matrix.md)); the approver creates the `POLICY_RELEASE` approval record (the coding agent cannot).
6. Deploy with the pinned `policy.expectedVersion` and `expectedDigest`; the production guard rejects unknown versions.
7. Record when the new policy changes a pending action (workflows recheck policy before later disclosure or material change).

## Verification

Gateway reports the new policy version and digest; golden probes pass against the deployed WASM; no unexpected denials or allows on dashboards (`vsp_policy_decisions_total`).

## Communication roles

Policy approver; security leadership; deployment operator; privacy counsel (if data access changes); support operations lead (if caller-facing eligibility changes).

## Drill requirement

Release and rollback rehearsal in a non-production environment before pilot.
