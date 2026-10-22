# Model emulator (WP-08; FO-16-18, FO-09-36)

TEST EMULATOR: never imported by production sources (the architecture suite enforces it). `server.ts` serves OpenAI
Responses SSE, vLLM Chat Completions SSE and Bedrock ConverseStream (AWS event stream, SigV4 verified) plus the
catalogue listings, keyed by host name, refusing unregistered hosts. `main.ts` is the container entry point of
`deploy/local/services/model-emulator.compose.yaml` (profile `models`; the pinned Node image runs the checkout's code
from a read-only bind mount, so no image is built locally).

Admin API (plain HTTP, 127.0.0.1 only; published as `VSP_PORT_MODEL_EMULATOR_ADMIN`, default 58611; HTTPS on
`VSP_PORT_MODEL_EMULATOR`, default 58610):

| Request | Effect |
|---|---|
| `GET /__emulator/health` | liveness |
| `POST /__emulator/tls {servername, cert, key}` | certificate for one server name (SNI) |
| `POST /__emulator/hosts {host, credentials: {bearer, aws, region, models, toolMarkup}}` | register a host with its synthetic credentials (`bearer: "none"` for a vLLM server without `--api-key`) |
| `POST /__emulator/scripts {host, scripts}` | queue scripts, one per request |
| `POST /__emulator/faults {host, fault, count, override}` | queue MODEL_REFUSAL, MODEL_HANG or MODEL_OVERLOAD (the injection points of the FO-17-24 runs owned by WP-15 and WP-17) |
| `GET /__emulator/requests?host=` | the content-free request log (authorization, SigV4 result, `store`, stream, script, status, frames written, client closed early) |
| `DELETE /__emulator/hosts?host=` | forget a host |

`harness.ts` composes the production ports over the in-process emulator for Layer-1 tests (`egressClasses` sets the
exact classes the endpoint's destination approves); `catalog-tools.ts` turns the gateway's pinned catalogue
(`schemas/tools/catalog.json`, JSON Schema 2020-12) into model tools with one synthetic valid argument set per tool; `cassettes.ts` and
`record-cassettes.ts` (re)generate the committed cassettes in `recordings/`
(`cd platform && npx tsx test/emulators/models/record-cassettes.ts`).

The shared `model-emulator` container loads this code when it starts. After an emulator change (a new script or
`malformed` variant) the running container keeps serving the old code until the models profile is restarted
(`make up PROFILE=core,models` after the container stopped); Layer-2 tests therefore use only variants that the
committed emulator has served for at least one restart, and new variants are exercised at Layer 1 first.
