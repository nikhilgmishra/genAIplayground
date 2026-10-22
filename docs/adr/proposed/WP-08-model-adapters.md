# ADR (proposed by WP-08) Provider-specific model adapters over the egress-classified transport, model endpoint classes, protocol-exact emulators and a real-model local profile

| Field | Value |
|---|---|
| Status | **Proposed** (phase C; the phase integration package assigns the ADR number). Use with real providers, PHI or paid calls: **Pending human approval** (AIN-02, AIN-26, AIN-27, AIN-28, AIN-30, AIN-49) |
| Date | 2026-10-21 (revised 2026-10-22 after the r2 security and acceptance review) |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Security leadership and privacy counsel (model endpoint classes, data controls per endpoint and region); procurement (provider accounts); finance (paid calls) |
| Origin | `docs/adr/proposed/WP-08-model-adapters.md` |

## Context

Follow-on FO-09-06 to FO-09-09, FO-09-11, FO-09-36, FO-09-45, FO-09-46, FO-16-18, FO-16-24, FO-19-09; ADR-0018
decision 5 (real model adapters behind a ModelRegistry) and docs/ARCHITECTURE.md section 6.4 rule 1 (the untrusted-output
group, of which `platform/src/models` is a member, may reach the network only through the egress-classified transport
of WP-06). Wave B3 handed the privacy/egress owner the question whether canonical UUID path segments are opaque in the
egress URL check. Environment status of everything here: NOT_CONFIGURED; no real provider has been called.

## Decision

1. **One port, provider-specific results.** `ModelPort.invoke` takes one request shape (instructions in their own
   channel, caller, document and tool content as data, a declared data class, a budget) and returns a typed union that
   never throws for a provider outcome: COMPLETED, REFUSED, INCOMPLETE, OVERLOADED, TIMED_OUT, CANCELLED, MALFORMED,
   UNAVAILABLE, FAILED, each with its provider's own detail (OpenAI `status` and `incomplete_details`, Bedrock
   `stopReason` and modelled exception, vLLM `finish_reason`, served model and pinned tool parser) and an error class
   RETRYABLE, PERMANENT or UNKNOWN. Only a COMPLETED result has speakable text.
2. **Three adapters, three protocols, one transport.** OpenAI Responses and vLLM Chat Completions are parsed by our own
   incremental SSE parser, with request bodies typed against the official SDK's types (type-only imports); Bedrock uses
   the pinned AWS SDK for SigV4, serialization and the event-stream decoder with its network handler replaced by a
   handler over the egress-classified transport, explicit credentials and region, `maxAttempts: 1` and
   `defaultsMode: "standard"`. No adapter opens a socket of its own (the WP-06 lint rules and architecture suite stay
   unchanged, no exemption).
3. **Resilience is the port's job, not the adapter's.** `ResilientModelPort` wraps every adapter in `callDependency`:
   an overall deadline (AbortSignal through every attempt and retry wait), an attempt timeout that closes the provider
   stream, a per-endpoint circuit breaker (overload, server errors and hangs open it; refusals do not), a bulkhead with a
   bounded queue, and at most three attempts for allowlisted transient reasons, honouring a provider Retry-After and
   ending the retries when the deadline cannot afford it; no retry once output reached the consumer.
4. **Safe fallback is computed, not generated.** `decideModelFallback` maps every non-completed result to the approved
   template `fallback.safe_explanation` plus a human offer (`HANDOFF_PROPOSAL AI_UNAVAILABLE`), or to the safety
   acknowledgment and `SAFETY_PRIORITY` when the turn carries a safety signal, without calling a model or depending on a
   breaker (OPS-02, SAFE-03).
5. **Model endpoints are their own egress classes.** New destination kinds `MODEL_PROVIDER_API` and
   `MODEL_SELF_HOSTED` carry the provider, region and retention terms they were approved under; the generic
   `MODEL_ENDPOINT` kind (connector profiles) cannot be used by the adapters. Each adapter's transport checks every
   request with `EgressGuard.forModelEndpoint(binding)`, so a request can never reach a destination approved under other
   terms; `egress-startup.ts` checks composed model endpoints the same way at startup.
6. **Configuration is typed and validated outside the composition root.** `platform/src/models/port/config.ts` holds
   the endpoint schema and `modelEndpointGuardViolations` (blocking violations plus a per-endpoint CONFIGURED /
   NOT_CONFIGURED status); `platform/src/models/adapters/factory.ts` composes CONFIGURED endpoints only. The live
   composition root (WP-17) calls both; credentials reach the factory as opaque handles.
7. **Emulators are protocol-exact and live in test code.** The emulator renders each provider's documented wire format
   (SSE events typed against the SDK's event types, AWS event-stream frames with CRCs, SigV4 verified on every Bedrock
   request), enforces the providers' documented request rules, keys all state by host name, refuses unregistered hosts
   and injects the MODEL_REFUSAL, MODEL_HANG and MODEL_OVERLOAD faults. It runs in-process for Layer 1 and as the
   `model-emulator` compose service (profile `models`, the pinned Node image running the checkout's code read-only, no
   locally built image) for Layer 2. A recorded-response provider replays committed cassettes through the same adapters
   with no network.
8. **The real-model local profile needs a reviewed credential or licensed weights, nothing else.** Evaluating a
   profile never opens a socket; without a credential value, a review record (or a licence review of local weights),
   an egress entry for the endpoint's terms and synthetic-only data it is NOT_CONFIGURED and nothing is composed; a paid
   live provider also needs a billable-execution approval id before `run` sends anything.
9. **UUID path segments: the B3 hand-off is rejected as written and replaced by reviewed per-destination constants.**
   Hosted IdPs such as Microsoft Entra put the tenant id in the issuer path (`/<tenant-uuid>/v2.0`), which the URL
   scan refuses when the UUID happens to hold a long decimal run (OIDC_EGRESS_REFUSED). The proposed diff made every
   UUID-shaped token opaque. A first narrowing (whole path segment, RFC 9562 layout, a floor of hex letters) was
   refuted by the security review: the 8-4-4-4-12 groups carry decimal data (a phone number, an SSN, an account
   number) and three appended hex letters satisfy any letter floor. No shape rule separates a random UUID from decimal
   data dressed as one, so there is NO generic UUID exemption. Instead an egress destination may list reviewed
   `opaquePathIds`: exact lower-case canonical UUIDs (1 to 8) from the egress configuration, for example the tenant
   id of the IdP that destination is. Such a constant carries no request data. It is exempt only as a WHOLE path
   segment of a URL to the destination that lists it (compared case-insensitively); a segment holding the constant
   together with any digit is refused outright; query and fragment values never use the exemption; every unlisted
   UUID is scanned exactly as before (about 6 % of random v4 UUIDs hold a 9-digit run and still fail closed, which
   listing the constant fixes). A deployment that uses a hosted IdP lists its tenant id in that IdP's egress destination.
10. **Refusals are typed per provider, with a classifier where the provider has no signal.** OpenAI's refusal content
    part (streamed or only in the terminal response) is REFUSED MODEL_REFUSAL; Bedrock `guardrail_intervened` (only
    with the endpoint's `guardrailConfig`) and `content_filtered` are REFUSED; vLLM and a Bedrock model without a
    guardrail refuse in plain text with a normal stop, so `ResilientModelPort` runs the refusal classifier
    (`port/refusal.ts`) on every COMPLETED text-only result: a refusal opening that ends its clause (English and
    Spanish, any subject form, plus the endpoint's configured phrases such as a guardrail's blocked message) becomes
    REFUSED CLASSIFIED_REFUSAL, never speakable. A conditional statement ("I can't help with that until you are
    verified") stays COMPLETED. Best effort: prose the classifier misses is still checked by the harness (WP-10).
11. **Tool calls are proposals checked against the request that offered them** (`port/tool-calls.ts`): the tool was
    offered (or is Bedrock's forced structured-output tool), the tool choice is respected (`none` and an empty tool list
    allow no call, a named choice only that tool, `required` at least one), call ids are unique, and the arguments
    validate against the declared JSON schema (Ajv, pinned; schemas compiled before any I/O, a schema that does not
    compile refuses the request). A violation is MALFORMED, never COMPLETED. The validator applies the dialect the
    schema declares (JSON Schema 2020-12, the gateway catalogue's dialect and the default, or draft-07; any other
    `$schema` is refused), in strict mode with `format` asserted (ajv-formats), so a keyword it cannot apply refuses
    the request instead of being ignored; and every schema is compiled by its own validator instance with no shared
    `$id` registry (`addUsedSchema: false`, no loader), so compilation never depends on process history and a `$ref`
    resolves only inside its own schema, never to another request's, tenant's or tool's schema or a remote document.
    Compiled validators are cached by the digest of (dialect, schema), at most 256 of them (least recently used
    evicted). Cost: about 10 ms per distinct schema on first use (meta-schema compiled per instance), then cached.
    Tool names must be unique (MODEL_TOOL_NAME_DUPLICATE before any I/O; for Bedrock the forced structured-output tool
    counts), so a call can never be checked against a looser duplicate. Structured output is the port's check too
    (security review r4): a request's `responseSchema` is compiled before any I/O for every provider
    (MODEL_RESPONSE_SCHEMA_INVALID), an endpoint that cannot enforce it refuses the request before any I/O
    (MODEL_STRUCTURED_OUTPUT_UNSUPPORTED: a vLLM endpoint without json_schema; the schema is never dropped silently),
    and the COMPLETED answer must satisfy it with the same isolated validator: OpenAI and vLLM text must parse as JSON
    and validate, and the Bedrock answer is the forced call with no free text beside it; otherwise MALFORMED
    MODEL_STRUCTURED_OUTPUT_INVALID. A plain-text refusal is still classified first (REFUSED).
12. **The endpoint's `maxDataClass` is enforced per request** by `ResilientModelPort` before any I/O
    (UNAVAILABLE MODEL_DATA_CLASS_EXCEEDS_ENDPOINT, attempts 0), independently of the destination's approved classes:
    one destination host can serve endpoints with different data controls. The destination check then runs per request
    inside the transport. A verification-secret ceiling is a configuration violation (AUTH-06).
13. **Bedrock authentication is pinned to SigV4 with the composition root's handle.** `authSchemePreference: ["sigv4"]`,
    an `httpAuthSchemeProvider` that offers only `aws.auth#sigv4`, and a bearer token provider that refuses, so
    `AWS_BEARER_TOKEN_BEDROCK`, `AWS_AUTH_SCHEME_PREFERENCE` and an SSO profile in `~/.aws` can neither send an ambient
    Bedrock API key nor make the SDK's own HTTP client refresh an SSO token outside the egress-classified transport.
14. **An exchange ended by the port's own overall deadline is a provider failure.** The deadline is not the caller's
    signal: the attempt it aborts ends as TIMED_OUT DEADLINE, which the breaker counts (a hang opens the breaker even
    when the attempt timeout equals the deadline); a caller abort (barge-in) stays CANCELLED and neutral.
15. **The real-model profile derives billability and the review requirement from the destination**, never from a
    label: EMULATOR only when the endpoint host is loopback-routed to an emulator (an `emulator` label without such a
    route is a profile error); SELF_HOSTED_PRIVATE only for a vLLM endpoint on the private address class with a
    MODEL_SELF_HOSTED destination (the only case where licensed weights replace a credential review); everything else is
    HOSTED: a paid call that is not executable without a billable-execution approval id.
16. **Invocation audit records are keyed and honest.** The input digest is HMAC-SHA256 under the audit or tenant digest
    key from the composition root (at least 32 bytes), never a bare SHA-256; a record (which states
    `egress.endpointAllowlisted: true`) exists for every call whose request bytes reached or may have reached the
    endpoint (`ModelResult.sentAttempts >= 1`, counted per attempt from the transport's sent / not-started
    classification, whatever the outcome: a 401/403 after send is a FAILED record MODEL_AUTH_REJECTED) and whose
    class the endpoint's own egress check allows. The outcome is never the proxy for "sent", and the count is never
    taken before an in-flight attempt has settled: a caller abort or an attempt timeout rejects before the adapter has
    closed its exchange, so the port waits (bounded, 100 ms) for open attempts and counts one still open as sent (fail
    toward recording; security review r4 found a cancelled Bedrock call without a record). The record's budget is the
    request budget capped at the endpoint ceiling (`budgetCeiling`). Refusals before any byte was sent are visible in
    content-free metrics only.
17. **Stream checks fail closed.** The SSE parser is bounded per event, not per chunk, so a long well-formed answer
    delivered as one buffered body is COMPLETED; OpenAI events without `sequence_number` and vLLM chunks without the
    pinned `model` are MALFORMED (a field that is absent can no longer skip its check). OpenAI streams must also be
    internally consistent: a function_call never closed by `response.output_item.done`, a terminal event whose
    embedded `response.status` disagrees with its type, a function_call only in the terminal output, a terminal output
    that does not repeat the streamed calls exactly, and events on a closed call are MALFORMED. vLLM content or tool
    deltas after `finish_reason`, and a tool call renamed mid-stream at the same index, are MALFORMED. Bedrock
    ConverseStream follows the documented frame order (security review r4): one messageStart first; nothing but one
    metadata event after messageStop, so a later stop never overrides the first and no content is appended after it
    (MODEL_STREAM_CONTENT_AFTER_STOP); a refusal stop (guardrail_intervened, content_filtered) is sticky, so whatever
    follows it the stream is REFUSED, never COMPLETED or a retryable failure; one contentBlockStart per index, no
    toolUse delta into a closed, unknown or text block (MODEL_TOOL_CALL_INVALID); every toolUse block closed before a
    completing stop (MODEL_TOOL_CALL_UNCLOSED); and the stop reason must agree with the content: tool_use exactly when
    there is a call (MODEL_STOP_REASON_INCONSISTENT). That last rule fails closed for a model that reports end_turn
    with a tool call; the credentialed qualification run (NOT_RUN) must confirm each pinned model's stop reasons.
    An ARN model id (application inference profile, provisioned throughput) carries the account id in the request
    path, which the egress URL scan refuses, so such an endpoint is NOT_CONFIGURED until the egress policy can list the
    pinned id as an opaque path value.
18. **Catalogue snapshots keep no account identifiers**: `ownedBy` values naming an account become `ACCOUNT_SCOPED`,
    fine-tuned ids and ARNs with an account id become `account-scoped:<HMAC-SHA256 prefix>`, keyed with the
    catalogue digest key from the composition root (stable across snapshots) or, without one, a random key per snapshot
    that is never stored (an unkeyed digest of an ARN would let anyone enumerate the 12-digit account id offline); the
    pinned check runs on the
    provider's ids before redaction.

## Consequences

* Streaming: the WP-06 transport hands over a response when it has ended. Parsing, typing, cancellation and deadlines
  are exact, but time to first token equals the response time and the first-event / idle watchdog is not armed. An
  additive incremental `stream()` method on the transport is handed to its owner (diff in the WP-08 report); the
  factory detects it and composes `StreamingTransportModelExchange`, whose incremental delivery and watchdog are
  unit-tested over a labelled fake streaming transport (`streaming.test.ts`), so no adapter change is needed.
* The metric catalogue fragment lives in `platform/src/models/port/metrics.ts` (`withModelMetrics`) until the
  composition owner moves it to `platform/src/observability/catalog/models.ts` and lists it in `catalog/index.ts`
  (the catalogue merge test requires every fragment file there to be listed).
* Bedrock model ids that contain a date in `YYYY-MM-DD` form are refused by the egress URL check (fail closed); ids in
  the provider's usual compact form pass. Recorded here so the registry (WP-09) can pin inference-profile ids instead.
* The refusal classifier can misclassify: a false match costs the caller the generic fallback and a human offer; a
  miss leaves a refusal as COMPLETED text that the harness (WP-10) and gateway still check before speech.
* An endpoint that must reach a hosted IdP-style path with a tenant UUID (or any reviewed UUID constant) needs that UUID
  listed in its destination's `opaquePathIds`; until then such URLs keep failing closed.
* Not proven locally: model quality, real latency, provider quotas and tokenization, provider data controls, real vLLM
  tool parsing on licensed weights (no GPU, AIN-27). Those stay NOT_RUN until a credentialed run under AIN-26 / AIN-30.

## Alternatives considered

| Alternative | Why not |
|---|---|
| The official OpenAI SDK as the wire client (custom fetch over the transport) | Adds a fetch shim and SDK-owned retries and timeouts in the request path; our parser is small, bounded and incremental, and the SDK's types still check the request bodies and emulator events at compile time |
| Hand-written SigV4 and event-stream decoding for Bedrock runtime | The AWS SDK is pinned and is AWS's own implementation; replacing only its network handler keeps the protocol exact and the egress check in the path |
| Accept any UUID-shaped token anywhere in the URL (the B3 proposal as written) | Query values would lose the digit-run check, digits glued to a UUID would pass, and decimal data written in UUID groups would pass |
| A UUID shape rule (whole path segment, RFC 9562 layout, a floor of hex letters, a hex letter in the node field) | Refuted by the security review: a phone number, SSN or account number in the decimal groups plus three hex letters meets every such rule; no shape distinguishes data from a random id |
| Trust the provider's refusal signal only | vLLM has none and Bedrock has one only with a guardrail; a plain-text refusal would be spoken |
| Leave tool-call validation to the gateway only | The port would hand the harness calls the request never allowed; the gateway still re-validates, this is defence in depth |
| A local vLLM server on CPU with downloaded weights in the compose file | Model downloads and licences (AIN-28) are not part of a default command; a 4-CPU host cannot qualify throughput; the emulator covers the protocol and the parser failure mode |
