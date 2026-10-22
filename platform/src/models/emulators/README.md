# platform/src/models/emulators: protocol pieces of the model emulators (WP-08)

Pure protocol code shared by the emulator server (`platform/test/emulators/models`) and the recorded-response
provider. Nothing here opens a socket, and no production source imports this directory (the server that does open
sockets is test code).

| File | Contents |
|---|---|
| `scenarios.ts` | Scripts (`text`, `tool_call`, `refusal`, `guardrail`, `content_filter`, `max_tokens`, `overload`, `hang`, `server_error`, `stream_error`, `request_rejected`, `context_window`, `engine_abort`, `unexpected_status`, `malformed`, `auth_error`, `quota_exhausted`), the fault scripts `FAULT_SCRIPTS` (MODEL_REFUSAL, MODEL_HANG, MODEL_OVERLOAD) and the renderers of the three wire protocols, typed against the official SDK types. Refusals are rendered the way each provider really refuses: an OpenAI `refusal` content part; vLLM plain content with `finish_reason: stop` (vLLM has no refusal field or content filter); Bedrock `guardrail_intervened` only for a request that carried `guardrailConfig`, otherwise plain text with `end_turn`. `malformed` variants (bad JSON, truncation, replayed or missing sequence numbers, a refusal only in the terminal response, an OpenAI function_call never closed (`tool_call_unclosed`), an incomplete event claiming completed (`terminal_status_mismatch`), a function_call only in the terminal output (`tool_call_not_streamed`), vLLM content after `finish_reason` (`content_after_finish`) and a renamed tool call (`tool_call_renamed`), Bedrock-shaped variants (a toolUse block never closed (`tool_call_unclosed`), text after messageStop (`content_after_finish`), a second contentBlockStart at the same index (`tool_call_renamed`), a guardrail stop followed by a second end_turn stop (`refusal_overridden`)), leaked parser markup, a missing or different served model, bad CRC) are deliberately non-conformant. A structured-output request (OpenAI `text.format` json_schema, vLLM `response_format` json_schema) to a text model is answered with schema-shaped JSON (`syntheticArguments`) |
| `requests.ts` | The providers' documented request rules, enforced the providers' way (400 with their error documents) |
| `eventstream.ts` | AWS event-stream framing with both CRCs |
| `sigv4-verify.ts` | SigV4 verification (cross-checked against the AWS SDK's signer in the Bedrock adapter tests) |
| `recorded.ts` | `RecordingModelExchange` / `RecordedModelExchange`: cassettes of synthetic exchanges replayed through the production adapters with no network; neither can be built outside local and ci |

Fixture model ids (`emulated-text`, `emulated-tools`, `emulated-refusal`, `emulated-guardrail`, `emulated-overload`,
`emulated-hang`, `emulated-malformed`) are emulator configuration, not provider model identifiers.
