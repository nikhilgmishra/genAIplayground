# platform/src/models/adapters: provider adapters, factory, discovery, real-model profile (WP-08)

Status: software **IMPLEMENTED**, emulator-verified (Layer 1 in process, Layer 2 against the `model-emulator` compose
service); environment **NOT_CONFIGURED** (no provider account, credential or GPU host); real-model qualification
**NOT_RUN**. Port types, resilience and fallback are in [`../port`](../port/README.md); the emulator in
[`../emulators`](../emulators/README.md) and [`platform/test/emulators/models`](../../../test/emulators/models/README.md).

| File | What it does |
|---|---|
| `openai-responses.ts` | OpenAI Responses API, `POST /v1/responses`, `stream: true`, `store: false`; SSE events (text, refusal, function-call arguments, completed / incomplete / failed, `error`); `sequence_number` required on every event and strictly increasing (missing, replayed or reordered is MALFORMED); a refusal part in the terminal response is REFUSED even without a refusal delta; the stream must be consistent (a function_call never closed by `output_item.done`, a terminal event whose `response.status` disagrees with its type, a function_call only in the terminal output, a terminal output that does not repeat the streamed calls, events on a closed call: all MALFORMED); usage with cached and reasoning tokens; HTTP errors mapped (429 `insufficient_quota` PERMANENT, other 429 and 503 OVERLOADED with Retry-After or `retry-after-ms`, unrecognised error codes UNKNOWN) |
| `bedrock-converse.ts` | Amazon Bedrock ConverseStream on the pinned AWS SDK: SigV4, serialization and the event-stream decoder are AWS's; the network handler is `TransportRequestHandler` over the egress-classified transport; explicit credentials, region and endpoint, `maxAttempts: 1`, `defaultsMode: "standard"`; the auth scheme is pinned to SigV4 with the composition root's handle (`AWS_BEARER_TOKEN_BEDROCK`, `AWS_AUTH_SCHEME_PREFERENCE` and an SSO profile cannot select bearer auth or an SSO token refresh); stop reasons and modelled exceptions mapped (Validation / ResourceNotFound / ServiceQuotaExceeded PERMANENT, throttling OVERLOADED, unmodelled UNKNOWN); guardrails through `guardrailConfig`; structured output as one forced tool; the documented frame order is enforced (`bedrockStreamViolation`, fail closed): nothing but metadata after messageStop (a refusal stop stays REFUSED whatever follows), one contentBlockStart per index, no toolUse delta into a closed, unknown or text block, every toolUse block closed before a completing stop, and tool_use exactly when there is a call; an ARN model id is refused by the egress URL scan (NOT_CONFIGURED, documented limitation). Unit tests on hand-built frames in `bedrock-converse.wire.test.ts` (UNIT FAKE exchange, decoded by the AWS SDK) |
| `vllm-chat.ts` | vLLM OpenAI-compatible Chat Completions, `stream_options.include_usage`, `max_completion_tokens`, json_schema structured output; every chunk must name the pinned served model (missing or other is MALFORMED); leaked markup of the pinned tool parser (`TOOL_PARSER_MARKERS`) is MALFORMED; `finish_reason` abort / error RETRYABLE, 4xx PERMANENT; refusals are plain content, typed by the port's refusal classifier; content, refusal or tool deltas after the choice's `finish_reason`, and a tool call renamed at the same index, are MALFORMED |
| `http-exchange.ts` | `TransportModelExchange` over `ConnectorHttpTransport` (WP-06): failure mapping by transport phase, Retry-After, the stream watchdog (`watched`, armed when an exchange delivers incrementally) |
| `sse.ts` | Incremental SSE parser, bounded per event (never per chunk), so a whole buffered body of many small events parses linearly |
| `factory.ts` | `createModelPorts` for the composition owner: guard report first, then a `ResilientModelPort` per CONFIGURED endpoint, each over its own transport bound to the endpoint's egress terms; `modelEgressTargets` for the startup egress check |
| `discovery.ts`, `cli-discover-catalogue.ts` | Provider catalogue snapshot (OpenAI and vLLM `/v1/models`, Bedrock `/foundation-models` signed with `sigv4.ts`); account identifiers (org/user/project owners, fine-tuned ids, ARNs with an account id) are redacted or replaced by a KEYED digest (`--digest-key-file`, owner-only, at least 32 bytes, for digests stable across snapshots; otherwise a discarded random key per snapshot) |
| `real-model-profile.ts`, `cli-real-model.ts` | Real-model local profile: NOT_CONFIGURED without a reviewed credential or licensed weights, no network; billability and the review requirement come from the DESTINATION (emulator route, private self-hosted vLLM, or hosted), never from a label: every hosted destination needs a billable approval id |
| `provider-matrix.test.ts`, `resilience.test.ts` | Per-provider matrix over the in-process emulator (error classes, real-shaped refusals, tool-call checks, data classes, long streams) and factory-composed breaker, deadline and bulkhead |

## Commands

```bash
cd platform
npx vitest run src/models                    # adapters against the in-process emulator (no Docker, no network)
make -C .. up PROFILE=core,models            # the compose emulator
make -C .. test-integration SUITE=models     # Layer 2 over TLS
# Real-model local profile (status never touches the network; run sends one synthetic task when CONFIGURED):
npx tsx src/models/adapters/cli-real-model.ts status --profile <profile.json>
npx tsx src/models/adapters/cli-real-model.ts run --profile <profile.json>
# Catalogue snapshot for the registry (WP-09) and the release manifest (WP-40):
npx tsx src/models/adapters/cli-discover-catalogue.ts --profile <profile.json> --out <dir>
```

Exit codes of both commands: 0 done, 2 invalid profile, 3 NOT_CONFIGURED or not executable (nothing was sent), 4 the
call or listing failed. A profile (`real-model-profile.v1`) names the endpoint (`ModelEndpointConfig`), the credential
source (`env` variable `VSP_MODEL_*`, an owner-only `file`, `aws_env`, or `none` for a private vLLM server), the review
record (`approvalId`, `dataControlsRef`), `localWeights` (manifest digest and licence review) for vLLM, `billable`
(the AIN-30 approval id), its egress policy and, for emulator runs only, `emulatorRoutes`.

## Wiring for the composition owner (WP-17)

1. Load `models: ModelEndpointConfig[]` with the platform configuration; call
   `modelEndpointGuardViolations(models, { environment, egress })` from a guard rule file (blocking `violations` refuse
   the environment; `status` feeds the activation map as capability `models.providers`).
2. Resolve each CONFIGURED endpoint's credential in trusted code: a Secrets Manager ARN `credentialRef` through the
   connector `SecretResolver` (`local-fixture:` refs exist in local/ci only) into a `BearerCredential`;
   `aws:task-role` into an `AwsCredential` over the task role's provider. The models module never imports a resolver.
3. `createModelPorts(models, { environment, egress: guard, egressPolicy, clock, credentials, metrics, logger })` and hand
   the ports to the harness (WP-10) by `endpointRef`. Invocation audit records (`modelInvocationRecord`) need the
   audit or tenant digest key (at least 32 bytes) and `invocationEgressCheck(endpoint, guard)` (a non-counting
   `peekModelEndpoint` decision); every call whose request was sent gets a record, a call refused before any byte
   none. Pass the turn deadline as `budget.deadlineMs`, never as the abort signal.
4. Add `modelEgressTargets(models, environment)` to `egressTargetsFor(config, telemetry, models)` before startup.
5. Merge `MODEL_METRICS` into the platform catalogue (move to `observability/catalog/models.ts`, list it in
   `catalog/index.ts`).

## Streaming

`modelExchangeFor(transport)` picks the exchange by feature detection. Today `ConnectorHttpTransport` offers only
`send`, which resolves when a response has ended, so the factory composes `TransportModelExchange`
(`incremental = false`): deltas are parsed and emitted in order but only after the provider finished, and the
first-event / idle watchdog is not armed (the attempt timeout bounds a stalled stream; the emulator sees the
connection closed). When the transport owner (WP-06) adds the additive `stream()` method handed over by WP-08, the
factory selects `StreamingTransportModelExchange` (`incremental = true`) with no further change: deltas reach the
consumer while the provider is still generating and the watchdog ends a stalled stream as TIMED_OUT FIRST_EVENT or
STREAM_IDLE before the attempt timeout (`streaming.test.ts`, over a labelled unit-fake streaming transport).
