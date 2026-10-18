# MCP connection — Talkdesk AI Agent Platform → gateway `/mcp`

Status: **UNVERIFIED**. No Talkdesk MCP connection has been created. This is the
specification the Talkdesk administrator and the gateway operator apply together in the
approved sandbox (AR-01, AR-02). Sources: [S3] for Talkdesk transport/auth/versioning
statements; the MCP specification for transport behaviour. UI paths: **to be confirmed
from tenant documentation**.

MCP is an integration protocol, not a security guarantee ([S3], spec section 2). Service
authentication proves *which integration* is calling; it never authenticates the caller.
The gateway enforces authorization in the service that reads or changes data.

## 1. Endpoint

| Item | Value | Status |
|---|---|---|
| Transport | MCP Streamable HTTP (Talkdesk documents Streamable HTTP, [S3]) | documented, UNVERIFIED in tenant |
| URL | `https://${GATEWAY_SANDBOX_HOST}/mcp` | host UNKNOWN until `infra/terraform/envs/sandbox` is applied (AR-02) |
| TLS | TLS 1.2+ on the ALB listener; certificate from the sandbox account's certificate service | plan only |
| Methods | `POST` (JSON-RPC requests). `GET` (server-initiated stream) is not offered by the gateway unless a test shows Talkdesk requires it | design choice |
| Response mode | JSON response preferred for `tools/call`; SSE only if the Talkdesk client requires it (check MC-02) | UNKNOWN |
| MCP protocol revision used by Talkdesk | UNKNOWN (VQ-TD-24) | — |
| Gateway MCP implementation | thin adapter in `platform/src/gateway` using `@modelcontextprotocol/sdk` (pinned in `platform/package.json`) | owner: gateway module |

The MCP transport session header (`Mcp-Session-Id`) identifies an MCP transport session
only. It is **not** the caller session, carries no authority and is never used to
resolve `AuthContext`.

## 2. What the gateway exposes on `/mcp`

* `tools/list` returns exactly the pinned catalogue for the environment (see section 6)
  and the tool sets in `ai-agent-config.yaml`. No dynamic registration.
* `tools/call` for those tools only. Each call becomes a `ToolRequest`
  (`platform/src/protocol/tools.ts`) and goes through the pipeline in
  `docs/ARCHITECTURE.md` section 4.
* No resources, prompts, sampling, file access, shell or arbitrary fetch capability.
* Published gateway paths (generated description: `schemas/openapi/gateway.openapi.json`,
  checked in CI by `platform/src/gateway/generate-openapi.ts --check`): `POST /mcp`
  (stateless Streamable HTTP with JSON responses; `GET` and `DELETE /mcp` answer 405 and no
  `Mcp-Session-Id` is issued), `GET /v1/tools/catalog` and `POST /v1/tools/{name}/{version}`
  (`mcp_tools` credential). The caller session reaches the gateway only in the
  `X-VSP-Session-Ref` header (option A) or as the interaction id in `X-VSP-Interaction-Id`
  (option B); never in a URL, body or tool argument.
* Telephony-control operations are published as `POST /telephony/v1/calls` (TC-01) and
  `/telephony/v1/session/*` (TC-02..TC-08, TC-10..TC-12) with the session reference in the
  `X-VSP-Session-Ref` header, and the LOCAL FIXTURE transfer-event route as
  `POST /v1/webhooks/transfer-events` (TC-09, refused outside local/ci until the Talkdesk
  event authentication is documented). `studio-flow-spec.md` section 3 and
  `expected-config.yaml` `httpSteps` list exactly these published paths; the package
  validator ties them to each other and to `schemas/openapi/gateway.openapi.json`.

## 3. Service identities (separate per environment and per integration)

Secret values are never in the repository, chat or logs; owners create them and only the
**names** appear here (naming follows the `vsp-<environment>-<integration>` convention used
in `platform/config/sandbox.json`, owner: config module). The gateway maps a validated
credential to `IntegrationIdentity` (`platform/src/protocol/auth.ts`).

| integrationId | channel | Direction | Auth method | Credential custody | Secret name (owner creates, only if custody copy needed) | Owner |
|---|---|---|---|---|---|---|
| `talkdesk-sandbox` (credential `talkdesk-sandbox-mcp`) | `mcp_tools` | inbound: AI Agent Platform → gateway `/mcp` | `oauth2_client_credentials` (preferred) | client secret issued by the authorization server and entered in the Talkdesk MCP connection; the gateway validates access tokens against the issuer JWKS and holds **no** secret | `vsp-sandbox-talkdesk-mcp-client` | identity owner + Talkdesk admin |
| `talkdesk-sandbox` (credential `talkdesk-sandbox-studio`) | `telephony_control` | inbound: Studio HTTP steps → gateway telephony-control operations | `oauth2_client_credentials` if Studio HTTP steps support it (VQ-TD-22); else static exception AR-08 | as above; for a static exception the gateway stores only a hash | `vsp-sandbox-talkdesk-studio-client`, or `vsp-sandbox-talkdesk-studio-bearer-hash` under AR-08 | identity owner + Talkdesk admin |
| `talkdesk-telephony` (adapter id in `platform/config/sandbox.json`) | — | outbound: gateway → Talkdesk API | only if Talkdesk documents an API for the needed operation (interaction lookup, transfer; VQ-TD-23, VQ-TD-33) | Secrets Manager | `vsp-sandbox-talkdesk-telephony` | BLOCKED until a documented API exists; Studio-side routing is the default |
| `talkdesk-mcp-staging`, `talkdesk-mcp-production` | `mcp_tools` | inbound | as above | separate clients per environment | separate names | not requested in Phase 2 |

Rules:

* **One `integrationId` per Talkdesk tenant.** The session service binds a call session to
  the integration that started it (TC-01, `telephony_control`) and resolves it only for the
  same `integrationId` with a channel in {`mcp_tools`, `telephony_control`, `portal`}
  (platform/src/identity). The two Talkdesk credentials therefore share `talkdesk-sandbox`
  and differ only by channel and credential id; in `gateway.inboundAuth.clients` (config
  schema) each OAuth2 client maps to `integrationId: talkdesk-sandbox` with its own
  `credentialId` and exactly one channel. Two different integration ids would make every
  MCP tool call fail to resolve the session Studio started.
* A `telephony_control` credential presented on `/mcp` is rejected; an `mcp_tools`
  credential presented on telephony-control operations is rejected.
* A sandbox credential is rejected by staging and production gateways (environment
  claim/audience check).
* Talkdesk receives no business-system credentials (Salesforce, scheduling, billing,
  IdP). It holds only these service credentials.

## 4. Authentication

### 4.1 OAuth2 client credentials (preferred)

* Authorization server: the company's existing authorization server for service
  identities (owner: identity owner). Issuer, token endpoint and JWKS URL are recorded
  in `expected-config.yaml` once issued; currently UNKNOWN.
* Gateway validation: signature against the issuer JWKS (rotation supported), `iss`,
  `aud` (proposed audience `vsp-gateway-sandbox`), `exp`, `nbf`, client id → integrationId
  mapping, scope for the channel (proposed `vsp.mcp_tools` / `vsp.telephony_control`).
  Clock skew tolerance and token lifetime: set by the identity owner (UNKNOWN).
* Talkdesk side: whether the MCP connection supports the client-credentials grant against
  a third-party token endpoint, which fields it needs, and how it caches/refreshes tokens
  is **UNKNOWN** (VQ-TD-24). [S3] states bearer-token or OAuth2 authentication; it does not
  establish which OAuth2 grant.

### 4.2 Static bearer token (exception only)

Allowed only if OAuth2 is not workable for the actual plan **and** approval AR-08
(`STATIC_CREDENTIAL_EXCEPTION`, security leadership) exists. Then:

* Scope: one integrationId, one channel, sandbox only.
* High-entropy token generated by the owner; Talkdesk holds the token, the gateway stores
  and compares a hash only (`vsp-sandbox-talkdesk-studio-bearer-hash`); rotation interval
  set by security (value UNKNOWN).
* `AdapterConfig.authMethod = bearer_static_exception` with `exceptionApprovalId`
  (`platform/src/config/ports.ts`); production configuration rejects it without approval.
* Revocation: delete/rotate the secret and remove the hash; the gateway rejects the old
  token immediately.

## 5. Session reference transport (TB-01) and decision rule

The protected-tool path needs the caller's opaque `sessionRef` (created by TC-01, see
`studio-flow-spec.md`) **outside model-controlled arguments**. The three modes match
`PlatformConfig.sessionBinding.mode`.

| Option | Mode | How the gateway gets the session | Required evidence before use |
|---|---|---|---|
| A | `trusted_header` | Talkdesk injects the Studio variable `vsp_session_ref` as an HTTP header (proposed name `X-VSP-Session-Ref`) on every MCP request from non-model context | Talkdesk documents this for the actual plan (VQ-TD-23); MB-01..MB-04 PASS |
| B | `server_to_server_lookup` | Talkdesk passes its interaction identifier outside model arguments (header/metadata); the gateway resolves the session that TC-01 bound to *(tenant, integration, interaction id)*; optionally confirms the interaction is live through a **documented** Talkdesk API | Documented mechanism (VQ-TD-23, VQ-TD-36); MB-01..MB-05 PASS. No invented API. |
| C | `tool_argument_lookup_exception` | The model passes `sessionRef` as a tool argument | Approval AR-09 (security leadership) with compensating controls; recorded in `sessionBinding.exceptionApprovalId` |

Decision rule (apply in order, record the outcome in `capability-gate.md` CG-01):

1. If option A is documented and MB-01..MB-04 pass → use A.
2. Else if option B is documented and MB-01..MB-05 pass → use B.
3. Else → **protected tools stay BLOCKED**: the catalogue served to Talkdesk contains only
   `SAFETY_AND_HUMAN_ROUTE`, public-read and A0 intake tools. Protected work goes to
   humans.
4. Option C only if security leadership explicitly approves it (AR-09) after reviewing
   the residual risk: a prompt-injected or confused model could present another
   session's reference. Even then the gateway checks integration, tenant, call binding,
   generation, expiry and revocation on every call.

`platform/config/sandbox.json` (owner: config module) currently carries
`sessionBinding.mode: server_to_server_lookup` as a placeholder. This decision rule sets the
final value once CG-01 evidence exists; until then `expected-config.yaml` records the mode as
`UNDECIDED`, and drift-check reports whatever the tenant shows as a `NEW_FACT` for review.

In every option possession of an interaction id or a session reference alone is never
authority (spec section 7): the gateway reconstructs `AuthContext` from server-side state
and checks it is bound to the authenticated integration and the current call.

Binding tests (all `NOT_RUN`):

| Test | Assertion |
|---|---|
| MB-01 | Prompt-injection turn asking the agent to "use session ses_…" cannot change the value the gateway receives |
| MB-02 | Session reference of call 1 presented during call 2 → gateway denies (call binding) |
| MB-03 | Header/metadata absent → protected tools denied, safety/human tools still work |
| MB-04 | After a participant change the old generation is rejected |
| MB-05 | Interaction id of an ended call → lookup fails closed |

## 6. Tool catalogue pinning

External tool definitions are not versioned within the Talkdesk platform ([S3]). Therefore:

* The gateway serves one pinned catalogue per environment; its digest
  (`ToolCatalogManifest.digest`) is pinned in `ReleaseManifest.toolSchemaDigest` and
  `PlatformConfig.toolCatalog.expectedDigest`. In this package the digest is the
  placeholder `TO_BE_PINNED_FROM_RELEASE_MANIFEST`.
* The repository's committed catalogue is `schemas/tools/catalog.json` (generated from the
  business tool modules by `platform/src/gateway/generate-catalog.ts`; `--check` fails on
  drift and the gateway refuses to start when the modules it builds differ from it). It
  publishes 18 tools, each at version `1.0.0`, matching the versions in
  `ai-agent-config.yaml`; `get_login_guidance` and `prepare_billing_review` are published
  but not assigned to an agent in `ai-agent-config.yaml`. Its digest is copied into the
  release manifest (and then here) by the release process, not by this package.
* MCP `tools/call` carries a tool name, not a version. The gateway maps each name to the
  single pinned version for the environment. A breaking change ships as a new catalogue
  version (and, where both must coexist, a new tool name), never as a silent schema change
  under the same name.
* After any catalogue change the Talkdesk administrator refreshes the tool definitions in
  the MCP connection (UI path to be confirmed) and transcribes the tool names Talkdesk shows
  per agent into a copy of `observed-config.template.yaml`; `drift-check.md` compares them
  with `ai-agent-config.yaml`. Versions and schema hashes are checked by the gateway against
  the pinned catalogue, because Talkdesk does not version them. Whether Talkdesk caches tool
  definitions per session or refetches them is **UNKNOWN** (VQ-TD-25).

## 7. Load balancer, WAF, timeouts and buffering (verify in sandbox)

| Test | Check | Why | Status |
|---|---|---|---|
| MC-01 | ALB idle timeout exceeds the longest tool response (ToolDefinition `timeoutMs` ≤ 10,000 ms) plus margin, and any SSE stream duration | Premature 504 creates ambiguous outcomes | NOT_RUN |
| MC-02 | SSE (`text/event-stream`) passes through ALB/WAF without buffering or compression delay, if SSE is used | Streamable HTTP may stream responses | NOT_RUN |
| MC-03 | WAF body-inspection size limit for the ALB association is confirmed in current AWS docs; oversize handling blocks bodies above the 16,384-byte tool input bound | Uninspected oversize bodies | NOT_RUN |
| MC-04 | WAF rate rules do not throttle the approved sandbox test rate; production rates are tested separately (spec section 12 illustrative 400 rps sustained) | Self-inflicted outage | NOT_RUN |
| MC-05 | Gateway is stateless across tasks for MCP transport sessions (or session affinity is proven); killing a task mid-conversation does not break the next call | Fargate task replacement | NOT_RUN |
| MC-06 | Deregistration delay vs in-flight tool calls during deploy | Ambiguous commits during deploy | NOT_RUN |
| MC-07 | Talkdesk MCP client timeout and retry behaviour measured (VQ-TD-26); consequential tools use `PREPARED_ACTION_DIGEST` / idempotency keys so a platform retry cannot duplicate an effect (ACT-02) | Duplicate commits | NOT_RUN |
| MC-08 | Header size limits accommodate access tokens and the session header | Request rejection | NOT_RUN |
| MC-09 | IP allowlist of Talkdesk egress ranges (if published, VQ-TD-45) applied as a supplemental control only | IP allowlists are not authentication | NOT_RUN |

## 8. What the gateway rejects (fail closed)

The gateway owner implements these; this list is the contract the Talkdesk configuration
must not depend on violating. Reason codes are defined by the gateway module.

1. Missing, expired, wrong-issuer, wrong-audience or wrong-channel credential.
2. Credential for another environment or tenant.
3. Tool name not in the pinned catalogue; catalogue digest mismatch at startup.
4. Arguments that fail the strict schema: unknown fields (`additionalProperties: false`),
   wrong types, values outside enums, input above `maxInputBytes`.
5. Any argument attempting to set server-established fields (`SERVER_ESTABLISHED_FIELDS`
   in `platform/src/protocol/common.ts`: actor, role, subject, organization, assurance,
   consent, scopes, …) (AUTH-03).
6. Session not resolvable through the chosen TB-01 mode; expired (even before TTL cleanup),
   revoked, ended, generation mismatch, or bound to another integration/call (AUTH-04).
7. Protected tools when the policy decision denies (deny by default), including
   insufficient assurance regardless of the Talkdesk Auth Gate state (AUTH-07).
8. `commit_*` / `submit_billing_review` without a trusted `ActionConfirmation` bound to the
   prepared-action digest and current generation (ACT-01).
9. Requests while a kill switch or admission control closes the class — except
   `SAFETY_AND_HUMAN_ROUTE` tools, which stay available (SAFE-03).
10. Business-system responses with unexpected fields (output schema), and any attempt to
    return dependency free text as caller speech (only `SpeechDirective` templates).
11. Destination ids not in trusted configuration (SAFE-05).

## 9. Connection setup steps (operator)

1. Confirm AR-01 and AR-02 approvals exist; confirm the sandbox gateway health check
   passes and the catalogue digest matches the release manifest.
2. Identity owner issues the `talkdesk-sandbox` MCP OAuth2 client (custody copy, if
   required, under the secret name above) and hands the client secret to the Talkdesk
   admin through the approved secret-sharing mechanism (never chat, email or tickets).
3. Talkdesk admin creates the MCP connection in the AI Agent Platform (UI path to be
   confirmed from tenant documentation), endpoint `https://${GATEWAY_SANDBOX_HOST}/mcp`,
   auth per section 4, session transport per section 5.
4. Talkdesk admin assigns tools to agents exactly as `ai-agent-config.yaml`.
5. Run MC-01..MC-09 and MB-01..MB-05; record evidence ids; update `capability-gate.md`.
6. Transcribe the observed connection settings into a copy of
   `observed-config.template.yaml` kept outside the repository and run
   `node talkdesk/tools/drift-check.mjs <copy>`.

Rollback: disable the MCP connection in Talkdesk (UI path to be confirmed), revoke the
OAuth2 client at the authorization server, delete any custody secret, and confirm Studio
routes all callers to SF-H.
