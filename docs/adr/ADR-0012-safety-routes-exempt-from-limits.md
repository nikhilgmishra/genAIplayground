# ADR-0012 Safety and human-transfer routes are exempt from rate limiting and admission; other tool calls use per-call buckets; MCP batches are counted per message

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Limit values: engineering defaults pending SRE capacity review and written vendor quotas (PRQ-022) |
| Date | 2026-10-18 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | SRE lead with the platform owner (limit values, per-call share, edge WAF limit) |
| Related prerequisites | PRQ-011, PRQ-022, PRQ-049 |

## Context

Spec section 12: "Preserve an independent safe route even when cost or model circuit breakers
open"; use backpressure and admission control and shed noncritical work first. SAFE-02: safety
routing and human requests need no account authentication. SAFE-03: cost limits never silently
terminate a safety flow. Spec section 14 lists denial of service (threat T-19 in
[`../security/threat-model.md`](../security/threat-model.md)).

Review findings: **SAFE-HANDOFF-03** — the tool transports were metered by one route-wide bucket
per integration, so routine traffic of other calls could exhaust it and a `request_safety_route`
call then received 429. **VSP-GW-01** — one call could exhaust the whole integration's tool
budget. **VSP-GW-03** — an MCP JSON-RPC batch counted as one request however many messages it
held.

## Decision

1. **Classify before any limit.** A call of a `SAFETY_AND_HUMAN_ROUTE` tool
   (`request_safety_route`, `request_human_transfer`; the class comes from the pinned tool
   catalogue, never from the caller) is never counted and never throttled, on either transport
   (`isSafetyRouteTool`, `admitToolUnit` in `platform/src/gateway/http/tool-rate-limit.ts`).
2. **Two buckets for everything else.** Every other tool call and every other MCP message
   (initialize, tools/list, notifications, malformed messages) needs a token in both a per-call
   bucket and the per-integration ceiling (`ToolCallRateLimiter`). The per-call key is the
   trusted `X-VSP-Interaction-Id`, else a hash of the trusted session reference, else
   `unbound`; never a bearer value. Nothing is consumed when either bucket refuses. Defaults:
   600 requests per 60 s per integration and channel (`DEFAULT_RATE_LIMIT`,
   `platform/src/gateway/http/app.ts`); per call a fifth of that ceiling, never below 120 unless
   the ceiling is lower (`defaultPerCallWindow`). A refusal is HTTP 429 `RATE_LIMITED` with
   standard rate-limit headers.
3. **Route-level exemptions.** The generic per-integration route limiter
   (`@fastify/rate-limit`, keyed by the authenticated integration) skips routes marked
   `rateLimitExempt`: health, `telephony.screenUtterance` and `telephony.requestHuman`
   (`platform/src/gateway/http/telephony-routes.ts`). It also skips the two tool transports
   (`TOOL_RATE_LIMITED_OPERATIONS`: `tools.invoke`, `mcp.post`), which the tool limiter meters
   instead.
4. **MCP batches** (`platform/src/gateway/mcp.ts`): at most `MCP_MAX_BATCH_MESSAGES` (10)
   messages; an empty or larger batch is refused with JSON-RPC -32600 before any tool runs.
   Each message is counted on its own and dispatched one at a time, safety and human-route calls
   first; a throttled message gets its own JSON-RPC error (`MCP_RATE_LIMITED_CODE`, -32029)
   while the rest still run. A single throttled non-batch message answers HTTP 429.
5. **Admission and kill switches.** The trusted tool pipeline (`platform/src/gateway/pipeline.ts`)
   skips the mutation fence, kill switches and admission for `SAFETY_AND_HUMAN_ROUTE` tools. The
   admission controller (`platform/src/ops/admission.ts`) admits `SAFETY` and `HUMAN_ROUTE`
   first, before any I/O, whatever the budget, kill switches, capacity or degradation level; a
   new session in those classes draws from the safety reserve, and exceeding the reserve raises
   `vsp_safety_reserve_overdraw_total` (an alert, never a block). `validateShedding` refuses any
   shedding table that sheds `SAFETY` or `HUMAN_ROUTE`.

Tests (offline, LOCAL FIXTURE adapters, SYNTHETIC data): `platform/src/gateway/http/tool-rate-limit.test.ts`,
`platform/src/gateway/http/routes.test.ts` (`[SAFE-HANDOFF-03][VSP-GW-01]`),
`platform/src/gateway/mcp.test.ts` (`[VSP-GW-03]` batch accounting, safety-first dispatch, batch
cap), `platform/src/ops/admission.test.ts` (`[SAFE-03]`, shedding tables). Status:
IMPLEMENTED_OFFLINE.

## Consequences

* A tenant's routine tool traffic can no longer starve a safety or human-route call at the
  gateway, and one call can no longer exhaust the integration's tool budget.
* The gateway places no limit on safety-class calls. They remain bounded by the batch cap. The
  edge WAF rate-based rule (`infra/terraform/modules/ingress`, per source IP, ILLUSTRATIVE limit)
  blocks only outside the tool-caller paths `/mcp` and `/telephony/`. On those paths a Count rule
  with the same limit only counts and feeds the `<prefix>-waf-tool-path-rate-observed` alarm
  (plans only), so the edge does not rate-block a safety or human-route call. The OPA `WAF-RATE`
  gate refuses a plan in which a blocking rate rule (Block, Captcha or Challenge), a label chain,
  a custom rule group or a `rule {}` block could rate-block those paths. Residuals
  (`infra/terraform/README.md`): until the Talkdesk egress allowlist exists, one source can send
  unlimited requests to those paths (the gateway still authenticates each one; T-19); the managed
  rule groups were not evaluated against Talkdesk MCP traffic. The independent Studio human route
  stays outside the gateway (T-19).
* The exemption follows the tool actually invoked: naming a safety tool only ever runs that
  safety tool.
* Buckets are in memory per gateway process (as is the generic limiter's local store), so the
  per-integration ceiling applies per process, not across processes. Requests with neither
  trusted header share one `unbound` per-call bucket per integration.
* Values are engineering defaults; vendor-side quotas are UNKNOWN until TB-10 (PRQ-022), and a
  whole-Talkdesk outage needs a separate continuity arrangement (PRQ-049).

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| One route-wide bucket per integration for the tool transports (previous behaviour) | Routine traffic of other calls could 429 a safety call (SAFE-HANDOFF-03) and one call could drain the tenant (VSP-GW-01) |
| A separate, larger bucket for safety tools | Any finite safety bucket can still be exhausted; spec section 12 asks for an independent safe route |
| Count an MCP batch as one request | A batch would multiply the budget (VSP-GW-03) |
| Reject JSON-RPC batches outright | Older protocol revisions use them; a small bounded batch counted per message is enough |
| Shared (distributed) rate-limit store now | Needs a new dependency and capacity data that do not exist (PRQ-022); the per-process limit is documented instead |

## Linked requirements

SAFE-02, SAFE-03, OPS-02, SPEC-12.rate-limit, SPEC-12.admission, SPEC-14.dos.

## Revisit when

Written vendor quotas exist (PRQ-022), SRE sets limit values and dashboards (PRQ-011), the
gateway runs as more than one process per integration, or the edge WAF limit is set from the
Talkdesk egress inventory and measured traffic.
