# WP-06 proposed data flows: connector runtime

Engineering draft by WP-06 for privacy and security review, to be merged into
[`docs/privacy/data-flow-inventory.md`](../../data-flow-inventory.md) by the phase integration package. It is
not a risk analysis or a compliance determination. Every flow is implemented and exercised against the
protocol emulator only (SYNTHETIC data); none is configured in any environment (NOT_CONFIGURED). Retention
classes come from each connector profile and need approval per tenant and vendor.

| Flow | Data | Source -> destination | Storage and protection | Access | Retention / deletion | Logs and metrics |
|---|---|---|---|---|---|---|
| Connector read | Vendor records mapped to declared target fields; PROHIBITED fields never leave the mapping; classes per field (INTERNAL, PHI, FINANCIAL, ...) | Vendor API -> connector runtime (worker or gateway process memory) -> the calling module | TLS to an allowlisted host; egress class checked per request; response bounded; drifted records refused whole | Trusted server modules only (module register rule 3) | Per stream `retentionClass` and `deletionBehavior` from the profile (`retentionRulesFor`, consumed by WP-22) | Reason codes, opaque ids, digests; `vsp_connector_*` metrics with closed labels |
| Connector write | Declared request-body fields only (typed, bounded), server-derived idempotency key | Calling module (action executor) -> vendor API | As above; content-free receipt (request / response digests, secret version id) | Action executor (rule 2) | Vendor-side retention per contract; local receipt follows the action ledger's retention | Digests and outcome codes; never body values |
| Incremental read and checkpoint | Cursor, replay id, watermark, position digest, counters, mapping digest | Vendor change feed -> projection (caller's table) and `connector_checkpoints` (Aurora) | One transaction for projection and checkpoint; RLS per tenant; no delete or truncate; key immutable, counters monotonic | Worker role (read / write), console role (read) | Checkpoints are positions, not records; they follow the connector's lifetime | Positions and counts only |
| Credential resolution | Client secrets, private keys, API keys (references in configuration, values in Secrets Manager) | Secrets Manager -> process memory (bounded cache) -> token endpoint | Never in configuration, logs, errors, receipts or metrics; redacting holder | Task role `secretsmanager:GetSecretValue` on the connector's secrets (WP-39) | Rotation by version stage; cache TTL at most one hour | Version ids and resolution results only |
| Access tokens | Bearer tokens and granted scopes | Vendor token endpoint -> process memory | Cached per capability credential, bounded by expiry and `tokenMaxAgeSeconds` | Connector runtime only | Discarded on expiry, 401 or restart | Token request results only |
| Capability evidence | Probe steps and results, profile digest, capability, level, signature | Probe -> evidence record (WP-32 stores it) | Content digest signed by KMS; no record values | Integration owner, readiness | Evidence expiry per record | Evidence ids and results |

Open points for review: retention classes per vendor stream (AIN-36 inputs), which tenant approval covers
PHI egress per connector, and the storage location and retention of capability evidence (WP-32).
