# RB-SECRET-ROTATION Secret and key rotation

| Field | Value |
|---|---|
| Runbook id | RB-SECRET-ROTATION |
| Severity | Procedure (scheduled); SEV-1 on suspected compromise |
| Primary owner role | Security admin |
| Last drilled | NEVER (not yet run) |
| Status | Draft; Secrets Manager and KMS are plans only (`infra/terraform/modules/secrets`, `infra/terraform/modules/kms`). No secret exists in this repository |

## Inventory of secret types

| Secret or key | Holder | Rotation mechanism |
|---|---|---|
| OAuth2 client secrets for Talkdesk MCP and Studio clients | Authorization server and Talkdesk connection configuration; the gateway holds none (validates tokens via JWKS) | Issue new client secret, update Talkdesk connection, revoke old |
| Integration credentials (Salesforce, business systems, notification provider) | Secrets Manager (referenced by `credentialRef`, never inline) | Secrets Manager rotation; dual-credential overlap where the vendor supports it |
| Verification assertion signing keys | KMS / key store; JWKS publishes multiple active key ids | Add new key id, switch signing, retire old after max assertion lifetime |
| Approval signing key (trusted key for `approvals/`) | Security leadership (PRQ-023) | Re-sign is not possible by software; new key requires re-issued approval records by the approvers |
| Static token exceptions (only if approved, PRQ-052) | Secrets Manager | Shortest feasible rotation; exception reviewed at each rotation |

## Trigger and detection signals

Scheduled rotation; personnel change; suspected exposure (secret scanning hit, credential in a log or ticket, vendor notice); anomalous use of a service identity on `<prefix>-identity` or WAF logs.

## Immediate containment (suspected compromise)

1. Declare SEV-1; revoke the credential at the issuer first, then rotate.
2. Engage `INTEGRATION` for the affected integration if revocation breaks it ([kill-switch-operations.md](kill-switch-operations.md)).

## Evidence preservation

Privacy counsel determines any reporting obligations and deadlines; the software preserves evidence and supports the process.

* Record rotation time, credential id (never the value), actor and reason as a `SECURITY_AUDIT` event. Never paste secrets into tickets, chat or logs; never print them.

## Step-by-step actions

1. Create the new credential at the issuer; store it in Secrets Manager; the application reads the new version by reference.
2. Deploy or refresh consumers; confirm traffic uses the new credential.
3. Revoke the old credential; confirm failures from any lingering consumer are visible and handled.
4. For signing keys, keep the old public key in JWKS until every token signed with it has expired.

## Verification

* Old credential rejected by the issuer; no errors on the new one; audit record present.

## Communication roles

Security admin; SRE on-call; Talkdesk, Salesforce or identity owner for vendor-side updates.

## Drill requirement

Rotate each credential type once in a non-production environment before pilot; rotation cadence set by security leadership.
