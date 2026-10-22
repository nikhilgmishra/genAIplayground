# Layer-2 suite: models (WP-08)

```bash
make up PROFILE=core,models
make test-integration SUITE=models
```

The production model path (`createModelPorts` -> `ResilientModelPort` -> provider adapter -> `TransportModelExchange` ->
`ConnectorHttpTransport` with the per-request model egress check) over TLS to the `model-emulator` compose service;
the server name is verified against a private test CA generated per file with the system openssl. Every test
registers its own host names and synthetic credentials through the emulator's admin API, so files never share state.

| File | Requirement ids | What runs |
|---|---|---|
| `providers.test.ts` | FO-09-06, FO-09-07, FO-09-08, FO-09-09, FO-09-45, FO-09-46, FO-16-18, FO-04-19, DATA-01, AUTH-06 | OpenAI tool round trip with `store: false`; Bedrock tool round trip with every request SigV4-verified, a wrong key pair refused, and SigV4 with the handle kept under ambient bearer settings (`AWS_BEARER_TOKEN_BEDROCK`, `AWS_AUTH_SCHEME_PREFERENCE` with an SSO session; every socket goes to the emulator, nothing reaches the side SSO listener); vLLM served-name check and leaked parser markup; the MODEL_REFUSAL seam rendered as each provider refuses (OpenAI refusal part, vLLM plain content classified, Bedrock guardrail only with `guardrailConfig`, otherwise plain text classified) with the fallback; MODEL_HANG (connection closed; hangs ended by the overall deadline open the breaker per provider) and MODEL_OVERLOAD (Retry-After honoured for OpenAI and vLLM, Bedrock throttling); tool calls the request did not allow are MALFORMED per provider; the gateway's pinned catalogue (18 tools, JSON Schema 2020-12) offered per provider with a valid catalogue call COMPLETED and a schema-breaking one MALFORMED; invocation records per provider for a wrong key (sent, 401 / SigV4 403: FAILED record MODEL_AUTH_REJECTED), for a barge-in after the request reached the emulator (CANCELLED record, three runs per provider) and none for an egress-refused class (`sentAttempts` 0); structured output (schema-valid JSON COMPLETED, schema-breaking or free text MALFORMED, a vLLM endpoint without json_schema, an uncompilable schema and duplicate tool names refused with no request); error classes RETRYABLE / PERMANENT / UNKNOWN per provider; cancellation and the breaker; the endpoint data-class ceiling, the per-request destination check and an untrusted certificate never reach the emulator; a long stream (body above twice the per-event bound) is COMPLETED |
| `profile.test.ts` | FO-16-24, FO-09-11, FO-19-09, OPS-05 | the real-model CLI as a child process: no reviewed credential -> NOT_CONFIGURED, exit 3, zero emulator requests; a reviewed credential -> one synthetic task; the discovery CLI writing dated snapshots (OpenAI listing, SigV4-signed Bedrock control-plane listing) |

What this does not prove: model quality, real latency, provider quotas, tokenization, provider data controls and
retention, real vLLM tool parsing on licensed weights. Those stay NOT_RUN until a credentialed run (AIN-26, AIN-27,
AIN-30).
