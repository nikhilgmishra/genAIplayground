# RB-SECRET-ROTATION Secret and key rotation

| Field | Value |
|---|---|
| Runbook id | RB-SECRET-ROTATION |
| Severity | Procedure (scheduled); SEV-1 on suspected compromise |
| Primary owner role | Security admin |
| Last drilled | NEVER (not yet run) |
| Status | Draft; Secrets Manager and KMS are plans only (`infra/terraform/modules/secrets`, `infra/terraform/modules/kms`). No secret exists in this repository. The connector runtime's rotation handling (WP-06) is verified against LocalStack only (`make test-integration SUITE=connectors`) |

## Inventory of secret types

| Secret or key | Holder | Rotation mechanism |
|---|---|---|
| OAuth2 client secrets for Talkdesk MCP and Studio clients | Authorization server and Talkdesk connection configuration; the gateway holds none (validates tokens via JWKS) | Issue new client secret, update Talkdesk connection, revoke old |
| Integration credentials (Salesforce, business systems, notification provider) | Secrets Manager (referenced by `credentialRef`, never inline) | Secrets Manager rotation; dual-credential overlap where the vendor supports it |
| Verification assertion signing keys | KMS / key store; JWKS publishes multiple active key ids | Add new key id, switch signing, retire old after max assertion lifetime |
| Approval signing key (trusted key for `approvals/`) | Security leadership (PRQ-023) | Re-sign is not possible by software; new key requires re-issued approval records by the approvers |
| Static token exceptions (only if approved, PRQ-052) | Secrets Manager | Shortest feasible rotation; exception reviewed at each rotation |

## Connector credentials (connector runtime, WP-06)

Each connector capability has its own Secrets Manager secret (`capabilityCredentials[].credentialRef` in the
`ConnectorProfile`; a JSON object `{ "clientId", "clientSecret" }`, `{ "clientId", "privateKeyPem", "alg", "keyId"?, "subject"? }`
or `{ "apiKey" }`). How the runtime picks up a rotation, without a restart:

* The resolver caches a version for at most its TTL (default 300 s), so a promoted AWSCURRENT is used within
  that bound even when nothing fails.
* A 401 from the vendor API drops the cached token and the cached secret; the single refresh reads the
  current version. A second 401 fails closed (`CONNECTOR_AUTH_FAILED`, capability NOT_READY), never loops.
* A token endpoint answer `invalid_client` re-reads the secret once and retries only if the version
  changed; otherwise `CONNECTOR_TOKEN_CLIENT_REJECTED` and the capability turns NOT_READY.

Rotation steps for a connector secret (vendor that allows two active client secrets):

1. Create the new client secret at the vendor; store it as `AWSPENDING` (`PutSecretValue` with
   `VersionStages: ["AWSPENDING"]`) and test it with `verifyPendingCredentials(runtime)`
   (`platform/src/connectors/runtime/health.ts`). For each enabled capability credential it reads the
   `AWSPENDING` version and authenticates with it: a token request for OAuth schemes, and the synthetic-record
   read for the read credential (the only test for API-key and self-signed JWT schemes). Every row must be
   `PASS` before step 2. Traffic keeps using `AWSCURRENT` throughout, the check never sends a write, and a
   pending value the vendor refuses (`FAIL CONNECTOR_TOKEN_CLIENT_REJECTED`) does not change readiness; a
   credential with no staged version reports `FAIL CONNECTOR_CREDENTIAL_INVALID`.
2. Promote it: `UpdateSecretVersionStage` moving `AWSCURRENT` to the new version.
3. Wait at least the resolver TTL, confirm `vsp_connector_token_requests_total` shows issued tokens and the
   receipts' secret version id is the new one, then revoke the old client secret at the vendor.

For a vendor with a single active secret, steps 1 to 3 collapse: rotate at the vendor and promote in Secrets
Manager in one change window; requests in between fail once and recover through the refresh above. Never put
a secret value in a profile, a ticket or a log; profiles hold references only (admission refuses anything
else, and a KMS key ARN is not a secret reference).

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
