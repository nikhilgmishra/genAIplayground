# media/src: the conversation runtime on the media plane (WP-11)

A LiveKit Agents **Node** worker (`@livekit/agents` 1.9.2, `@livekit/rtc-node` 1.1.0). It registers with livekit-server
under an explicit agent name, receives dispatched room jobs and runs each in a forked job process. It reaches the
platform only through the gateway's media routes, over the egress-classified transport, with its own OAuth credential
(`docs/adr/proposed/WP-11-livekit-media-runtime.md`).

| Directory | Purpose |
|---|---|
| `worker/` | `server.ts` (Agents server; the composition entry point `media/src/main.ts` calls `startMediaWorker`), `agent.ts` (job entry), `call.ts` (`MediaCall`: one call), `config.ts` (configuration file plus three secrets from the environment; fail-closed rules for staging and production), `runtime.ts` (per-process transport, credential, gateway client, recorder), `room.ts` / `livekit-room.ts` (the room port and its rtc-node implementation), `framework-log.ts` (framework logs at warn only) |
| `binding/` | `MediaGatewayClient` (strict contracts of `platform/src/protocol/call-binding.ts`; one retry with a fresh token after a 401/403), `BindingManager` (one binding request at a time, in order; heartbeat, generation following, loss detection), `ClientCredentialsTokenSource` |
| `recovery/` | What to do when the binding cannot be obtained or is lost: re-bind, leave, or route to a person (SAFE-02) |
| `lifecycle/` | `CallParties`: caller, transfer leg, third party; hold, hang-up, media disconnect |
| `playback/` | Generation-fenced `PlaybackEngine` (holds for hold, transfer leg, unacknowledged party change and unbound call; flush, repeat, slower speech by WSOLA time stretch, comfort noise), `DtmfMenu` (digits to navigation actions; secure entry) |
| `recording/` | `ProcessingController` (consent-driven recorder and taps gated on consent at `now`, readout, reconciliation against the egress API with or without a recorder), `LiveKitEgressRecorder` (TrackEgress over the Twirp API; also the observe-only egress client), the RECORDING_REFUSED seam (local/ci only) |
| `codecs/` | G.711 µ-law/A-law (bit-exact with ffmpeg), PCM framing and levels, resampling, telephony legs, audio file decoding |

What the worker publishes on its own participant: `vsp.mediaProcessing` (the typed `MediaProcessingState` readout) and
`vsp.mediaHealth` (the call phase, inbound and outbound frame counts, the caller's peak level): opaque ids, phases,
counts and levels only. DTMF digits are never logged; only the selected action is.

Failure behaviour (SAFE-02, DATA-03, FO-10-09): lifecycle reports are delivered in order and retried until the gateway
acknowledges them (speech is held while a party change is unacknowledged; one not acknowledged within
`recovery.lifecycleDeadlineMs` fails safe to a person); the processing readout is reported on every reconciliation
tick and the answer's directive applied at once (at most 5 s apart in staging and production); the room's egress list
is observed even when recording is disabled; a refused runtime token is replaced once by a fresh one; and a person that
could not be requested makes the job leave the room so the platform's media-plane supervisor routes the caller (the
gateway recorded the request for the room, so the supervisor routes the person instead of re-dispatching the AI).
Once a person or the safety route is requested the call never returns to an AI turn: speech is held, every recorder and
tap suspended, a bind still retrying cancelled and a binding issued anyway left to expire. A job the gateway refuses
because the caller is with a person (BINDING_WITH_PERSON) stays in the room silent and suspended until the caller hangs
up; one refused because a person is owed, or because the caller's consent sends them to a person, asks for the person.
A person requested for the room by anyone else (another runtime, the supervisor's deadline route) reaches a live owner
at its next gateway contact: the heartbeat is refused (BINDING_PERSON_REQUESTED or BINDING_WITH_PERSON) and the
lifecycle and processing answers carry it, and the owner suspends the same way. A job refused BINDING_OWNER_ACTIVE until
its bind deadline (a live owner holds the call) leaves the room instead of requesting a person.
After an owner loss only the recorders the gateway names for the call (`adoptableRecorders`) are adopted (the worker
logs how many, `media.recording.adopted`); any other running recorder, even one named under the call's path, is
foreign. A job refused into a person route holds no binding but still settles the call's recorders
(`recording/settlement.ts`): through the gateway's job-checked `media.recorders` route it learns the named recorders and
the consent, stops the named ones still running and flags (to the gateway) a running recorder the consent does not
permit, on every reconciliation tick while it stays in the room.

Tests: `media/test/*.test.ts` (Docker-free; `pnpm --filter @vsp/media exec vitest run`), which run the worker's call
handling against the production gateway routes in process (`media/test/support/gateway.ts`, labelled LOCAL FIXTURE KV
and media plane). Layer 2: `platform/test/integration/media` runs this worker as its own process
(`media/test/support/run-worker.ts`) against livekit-server, the egress service, Keycloak and the live composition.
