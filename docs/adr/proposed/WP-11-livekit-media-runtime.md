# ADR (proposed by WP-11) LiveKit Agents Node worker for the media path, CallBinding issuance and recovery, consent-driven recording control

| Field | Value |
|---|---|
| Status | **Proposed** (phase C; the phase integration package assigns the ADR number). Non-local use: **Pending human approval** (AIN-46 security review of the self-hosted media plane; recording storage and retention with privacy counsel) |
| Date | 2026-10-21 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Security leadership (media plane, runtime credential, recording path); privacy counsel (recording consent, disclosure, retention); SRE (worker fleet, egress capacity) |
| Origin | `docs/adr/proposed/WP-11-livekit-media-runtime.md` |

## Context

Follow-on FO-03-05, FO-03-17, FO-03-18, FO-03-44, FO-05-16, FO-10-01, FO-10-02, FO-10-09, FO-10-18, FO-10-46, FO-16-19,
FO-19-10, FO-22-16, FO-00-34 and FO-01-27; ADR-0018 decision 1.1 (LiveKit Agents for room, participant and audio-track
handling, never for model or tool orchestration), decision 1.6 (the runtime reaches the control plane only through the
gateway) and open item 2 (verify the VAD and turn-detection plugins exist for the Node framework at the pinned version).
Invariants: AUTH-03 (trusted identifiers never come from the runtime), DATA-03 (no recording or processing without
consent; UNKNOWN is not consent), SAFE-02 (safety and human routes need no session or binding). Environment status of
everything here: `NOT_CONFIGURED`; nothing has run against a carrier, a real caller or AWS.

## Decision

1. **Node worker, explicit dispatch.** The conversation runtime is a LiveKit Agents **Node** worker
   (`@livekit/agents` 1.9.2, `@livekit/rtc-node` 1.1.0, `livekit-server-sdk` 2.19.1 for the server API token and protocol
   classes) registered under an explicit agent name (`media/src/worker/server.ts`). livekit-server dispatches room jobs to
   it; each job runs in a forked job process (`media/src/worker/agent.ts`) that connects audio-only and runs one
   `MediaCall`. The framework's `AgentSession`, LLM, STT and TTS orchestration is not used: tool calls, budgets and typed
   state stay in the harness behind the gateway (WP-10).
2. **Verified plugin list (open item 2): no Python worker.** At the pinned version the Node framework has both plugins
   the media path needs, so no Python worker is added and there is no exception to record:

   | Function | Package (exact pin) | Licence | Verified by |
   |---|---|---|---|
   | Voice activity detection (Silero VAD, ONNX through `onnxruntime-node` 1.24.3) | `@livekit/agents-plugin-silero` 1.9.2 (`VAD`, `VADStream`) | Apache-2.0 | package exports read from the locked install; `platform/test/integration/_harness/deps.test.ts` runs the model on CPU (WP-03) |
   | Turn detection (end-of-utterance models `EnglishModel`, `MultilingualModel`) | `@livekit/agents-plugin-livekit` 1.9.2 (`turnDetector`) | Apache-2.0 | package exports read from the locked install; the end-of-turn model runs in `deps.test.ts` through `@livekit/local-inference` (WP-03) |
   | Agents framework, RTC transport, server SDK | `@livekit/agents` 1.9.2, `@livekit/rtc-node` 1.1.0, `livekit-server-sdk` 2.19.1 | Apache-2.0 | `media/test/worker-config.test.ts`, Layer-2 `platform/test/integration/media/worker.test.ts` |

   Using VAD and turn detection on caller speech is the speech path (WP-13); WP-11 only verifies they exist for Node.
3. **The worker holds a server-issued CallBinding, never builds one.** On each job the worker asks the gateway
   (`POST /media/v1/calls/bindings`, conversation_runtime credential) for the binding. The gateway verifies with
   livekit-server's own API that the job was dispatched to and assigned to that agent in that room (`ListDispatch`,
   `ListParticipants`), and binds the call to the TrustedSessionService session and its generation
   (`platform/src/calls/binding/service.ts`, DynamoDB conditional writes). Every later request carries the claim
   (binding id, generation, fencing token) copied from the gateway's answers; a stale or forged claim is refused with
   409 (AUTH-03). Starting a session supersedes the call's previous one (one live session per call), so the first
   record is created under a short first-bind lease: only its holder starts the call's session; a concurrent first
   bind (another worker, or the worker's own retry of a bind whose answer it lost under load) is refused retryably and,
   asked again, gets the same binding (its owner) or `BINDING_OWNER_ACTIVE` (anyone else).
   **One call, one room.** The media worker holds the media-plane API secret (the Agents worker registration signs its
   token with it), and a LiveKit API key cannot be scoped: whoever holds it can mint a participant of any kind with any
   attributes (a SIP-kind participant with a copied `sip.callID`), rewrite attributes (UpdateParticipant), remove
   participants and drive egress (shown against the shared livekit-server in Layer-2
   `platform/test/integration/media/carrier.test.ts`). `sip.callID` is therefore a fact about a room, not a proof of a
   call. The gateway pins each call to one room at the first touch (a bind or a session-less route): the room claim maps
   the room's server id to the interaction, the carrier interaction (the earliest-joined SIP party's `sip.callID`, else
   the room's server id for a WebRTC call) and that SIP party (identity digest); the carrier index maps the carrier
   interaction to the interaction and the claiming room. A carrier reference already claimed by another room is refused
   (`BINDING_ROOM_MISMATCH`, audited; that room's caller is routed to a person under a fresh interaction); a bind whose
   room name or server id differs from the call's pinned room is refused; a re-bind requires the pinned SIP party to be
   present with the pinned call id (gone: `BINDING_CALLER_GONE`, the call is ended; rewritten: `BINDING_CARRIER_CHANGED`,
   the binding is revoked and the live owner routes the caller to a person). A transfer leg that joins later never
   renames the call. What remains: a holder of the secret can still disrupt calls on its media plane (remove the agent,
   rewrite attributes, start egress); it cannot attach one call's session to another room. Proposed separation (needs
   the owners named below): (a) move egress start/stop behind the gateway (the worker asks; the gateway holds the
   secret), (b) a registration-token broker so the worker never holds the API secret (needs support in the Agents
   framework, which signs its own worker token at 1.9.2), (c) one media plane per tenant.
   SIP calls arrive through a livekit-sip dispatch rule whose room configuration dispatches the agent; such a rule
   without `hidePhoneNumber` builds the room name from the caller's E.164 number, so the room-name grammar accepts any
   name the media plane can assign (bounded to 256 characters, no control characters; refusing a name would also refuse
   the session-less human route), names go only to the gateway, are kept as digests and never logged, and deployments
   set `hidePhoneNumber` (Layer-2 `platform/test/integration/media/sip.test.ts`).
4. **Recovery re-binds with a new generation or routes to a person.** livekit-server (pinned v1.13.9) does not move a
   dead worker's room job to another worker (observed in the Layer-2 suite: it only tries to terminate the dead job),
   so the platform's media-plane supervisor (`platform/src/calls/binding/supervisor.ts`, one loop per deployment)
   dispatches a room again when its caller is still connected and no agent holding one of its jobs is; after a deadline
   without a stable runtime it routes the caller to a person (retried on every later sweep until the route succeeded;
   the orphan clock survives a runtime that joins and gives up again), and it ends the call at the control plane when
   it sees a caller it saw before gone (binding ENDED, pending actions void, session ended). Each sweep rotates through
   the room list in windows of `maxRooms`. The new job's bind succeeds only when the previous owner left the room or
   its binding expired without a heartbeat; the gateway then advances the session generation (owner recovery), raises
   the fencing token and voids the old owner's pending actions. While the previous owner is live the bind is refused
   (`BINDING_OWNER_ACTIVE`) and retried until a bounded deadline; still refused then, the owner is present and
   renewing, so the extra job leaves the room (a duplicate dispatch never sends a caller the AI is serving to a person;
   a room left without a runtime is the supervisor's); a call that cannot be re-bound for any other reason goes to a
   person through the session-less human route (SAFE-02). Mid-call losses are decided in `media/src/recovery/policy.ts`
   (another owner: leave; stale generation or unreachable gateway past expiry: re-bind; revoked, session invalid,
   credential refused: a person). **A runtime that cannot reach a person never stays in the room**: a human route
   refused (after one retry with a fresh runtime token on 401/403), unreachable or not accepted by its deadline makes
   the job leave, so the supervisor sees the caller without a runtime and routes the caller through its
   platform-internal path (no runtime credential, no room-name grammar).
   **A caller owed, or with, a person never goes back to the AI.** Every request for a person or the safety route is
   recorded for the room (the room's person request, `store.ts` `cbp#`, keyed by the room's server id) before the
   handoff is attempted; the human and safety routes and the supervisor's route share one person router
   (`media-routes.ts` `personRouter`): a room the media plane reports gone is refused, a safety route still owed is
   retried first, and an accepted request is answered again from the record (at most one standard and one safety
   handoff per room). The supervisor reads the room's person request before it re-dispatches: a person owed is routed
   on every sweep until accepted, a caller with a person is left alone, and a request that cannot be read (store
   outage, an item that does not parse) is never re-dispatched on a guess while the orphan clock runs, so the caller is
   routed once at the deadline. Only livekit's own Twirp `not_found` (or an empty room listing) makes a room "gone":
   any other 404 is a dependency failure and the routes go ahead. Every bind reads it too, before and after its
   write, and every heartbeat of a live binding: a person requested by anyone reaches the live owner within one
   heartbeat interval (the heartbeat is refused; lifecycle and processing answers carry it) and it suspends. A person owed is
   refused `BINDING_PERSON_REQUESTED` (the runtime asks for the person again), a person on the call
   `BINDING_WITH_PERSON` (the runtime stays in the room silent and suspended until the caller hangs up), and a recovery
   whose effective consent sends the caller to a person (AI processing declined, or recording declined where the
   tenant's alternative is a person) `BINDING_CONSENT_REQUIRES_PERSON`, before the session generation moves. On the
   worker, a person or the safety route ends the AI part of the call for good: a bind still retrying is cancelled, a
   binding issued anyway is left to expire, and a directive whose consent requires a person routes the call.
   **Issuance and recovery evidence is written exactly once** (OPS-01): the call record carries the state of the current
   binding's audit event (PENDING while the issuing request writes it, WRITTEN, MISSING); the owner's retry writes a
   missing event before it is answered (refused retryably while the writer may still be writing) and reports the issue
   kind the binding was issued with.
5. **Lifecycle on the media path fences pending speech and actions, and is delivered.** Party changes, holds (the
   caller's audio muted), transfer legs (a participant whose `vsp.participantRole` the transfer service set to
   `human_agent`) and hang-ups are reported to the gateway, which advances the session generation on a party change
   and voids pending actions. Reports are sent in order, one at a time with the binding's other requests, and retried
   (transport failures, 5xx, 429) until acknowledged or the binding is lost; signals seen before the bind wait for it.
   The worker refuses all speech while a hold, a transfer leg or an unacknowledged party change is in place (also speech
   of the current generation), drops queued and playing speech of an older generation at the next 10 ms frame, and
   refuses a segment of a generation the binding has not issued (`media/src/playback/engine.ts`). A party change, hold or
   transfer leg that cannot be reported within `lifecycleDeadlineMs` fails safe (no speech, a person); a hang-up that
   cannot be reported still ends the job (the supervisor ends the call).
6. **Consent-driven recording with an independent readout.** The recorder is the LiveKit egress service (one TrackEgress
   per party track, Ogg/Opus to the egress service's own storage; the worker never holds a storage credential). It and the
   in-process taps start only while `permittedTaps(consent, now)` allows them (GRANTED or NOT_REQUIRED, unexpired; UNKNOWN
   is not consent; the transcript and analysis taps are recording-dependent); a consent expiry closes the taps at the
   first frame past it and stops the recorder within one reconciliation. A decline or revocation closes the taps at the
   next frame and stops the egress; the readout (`MediaProcessingState`, published as the agent's `vsp.mediaProcessing`
   attribute and reported to the gateway on every reconciliation tick) keeps the recorder STOPPING until the egress API
   itself reports nothing running. The report's answer carries the current directive, so a consent change recorded in
   the control plane stops the recorder within one reconciliation interval (at most 5 s in a deployed environment;
   1 s in Layer 2), not at the next heartbeat; the gateway judges a readout by the consent the worker was last told
   (a readout below it is a stale worker). Reconciliation against the egress API runs whether or not the worker records
   (an observe-only egress client when recording is disabled) and flags a foreign recorder, a recorder refused or lost
   by the media plane, an egress API unreadable while ours may run (or past a bound at all), or a drain past its bound
   while the consent does not permit recording; any mismatch routes the call to a person. **Recovery adopts only the
   call's own recorders**: the readout lists the egress ids the worker started (`recorderRefs`), the gateway keeps them
   per binding on the call record, and the bind answer names them (`adoptableRecorders`); a new owner adopts exactly
   those that the egress API lists running as track egress to the egress service's own storage under the call's path.
   A recorder that merely names the call's path (the interaction id is published in the readout, and any holder of the
   media-plane secret or a roomRecord grant can start one, with an upload target of its own) is foreign: a mismatch and
   a person (the alternative "stop every running egress at recovery" was rejected: it would silently end evidence of a
   foreign recorder and is impossible for an observe-only worker). A job refused into a person route after an owner
   loss holds no binding but settles the call's recorders (`media/src/recording/settlement.ts`): the gateway's
   job-checked, binding-less `media.recorders` route names the call's recorders and its consent (nothing is issued),
   the job stops the named ones still running and flags a running recorder the consent does not permit to the
   gateway (recorded on the call and audited), on every reconciliation tick while it stays. The alternative of the
   gateway stopping egress itself (it holds the media-plane credential too) was deferred: it belongs with moving egress
   start/stop behind the gateway (decision 3, AIN-46). The `RECORDING_REFUSED` seam (local/ci only) drives the same
   decline path at call start.
7. **Codecs.** G.711 µ-law and A-law (bit-exact with ffmpeg), Opus decode and PCM 8/16/24/48 kHz resampling through
   the rtc-node resampler (`media/src/codecs`), tested against ffmpeg-generated fixtures.

## Alternatives considered

* **Python Agents worker** (the reference implementation): rejected while every plugin the media path needs exists for
  Node; a second runtime would split the contracts, lint rules and egress transport.
* **The framework's AgentSession with its own LLM/tool orchestration**: rejected by ADR-0018 decision 1.1 (tools,
  budgets and typed state stay behind the gateway).
* **Room-composite egress** (one mixed file): needs a browser template in the egress image (or the SDK audio
  composite); TrackEgress copies the encoded tracks with no transcoding and the least CPU. A mixed recording can be
  produced after the call from the party files.
* **A worker-published recording track gated per frame**: frame-exact for the recorder too, but the caller would
  subscribe to it unless track subscription permissions are managed per egress; rejected for now (the in-process taps
  are frame-gated; the egress stop is requested immediately and the readout stays honest while it drains).

## Consequences

* The media worker needs the LiveKit API key and secret (worker registration, the egress API) and the runtime OAuth
  client secret, injected into its environment by the deployment from the secret store. The LiveKit secret is the
  whole media plane (decision 3): the worker is trusted for the media plane it runs on, and the gateway's room pinning
  bounds what a compromised worker can do to the control plane (no cross-call session, no forged carrier). The proposed
  separation (egress control behind the gateway, a registration-token broker, a media plane per tenant) is a decision
  for security leadership with the composition owner (WP-17) before non-local use (AIN-46).
* The rate limit of the binding routes is per call (runtime credential plus binding, or plus a room digest for
  issuance), so load on one call never turns another call's heartbeats into refusals.
* The gateway's media routes, the binding store and the media-plane lookup have to be composed by WP-17
  (`platform/src/main/**`), with a separate DynamoDB table (or key space) and a dedicated sealer key for the sealed
  session reference.
* Egress capacity and the recording bucket (encryption, Object Lock, retention) are infrastructure decisions (WP-17,
  WP-44) pending the privacy review.

## Verification (local)

`pnpm --filter @vsp/media exec vitest run` (codecs, binding client and manager, recovery, lifecycle, playback, recording,
worker configuration, MediaCall against the production gateway routes in process); platform unit tests of
`src/calls/binding`, `src/gateway/http/media-routes.test.ts`, `src/protocol/call-binding.test.ts`; Layer 2
`make test-integration SUITE=media` (worker registration and dispatch, audio both ways, crash and re-bind with a new
generation, stale claim refused, runtime tokens of other Keycloak clients and without the runtime scope refused,
SAFE-02 routes without a binding, a forged carrier reference in a second room refused and a rewritten one revoking the
binding) and `FILTER=recording` (egress start on consent, decline by DTMF, a foreign recorder next to the consented one
routed to a person with the own egress ended, a foreign recorder seen by a worker with recording disabled, the
RECORDING_REFUSED seam).
