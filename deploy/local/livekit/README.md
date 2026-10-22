# deploy/local/livekit: local media-plane configuration (WP-11)

livekit-server and livekit-sip are composed by `deploy/local/services/core.compose.yaml` (WP-03). This directory holds
what the media path adds:

| File | Purpose |
|---|---|
| `egress.yaml` | Configuration template of the LiveKit egress service (`livekit/egress:v1.15.0`, digest-pinned in `platform/test/integration/media/support.ts`). The Layer-2 recording tests start it as a throwaway container on the host network, filling the `${VSP_*}` placeholders from the generated local state and the test's own bucket and ports |

Local fidelity notes (also in `docs/adr/proposed/WP-11-livekit-media-runtime.md`):

* livekit-server advertises 127.0.0.1 ICE candidates for host-side participants, so the egress service runs with
  `--network host` (a container on the compose network could not reach the media) and reaches valkey and MinIO on their
  published loopback ports.
* livekit-server's Twirp JSON uses the proto field names (`agent_dispatches`, `participant_identity`); readers must
  accept them (`platform/src/calls/binding/livekit-lookup.ts`).
* livekit-server does not re-dispatch a room job when the worker holding it dies (it logs a failed TerminateJob);
  the platform's media-plane supervisor (`platform/src/calls/binding/supervisor.ts`) dispatches the room again.
* A job appears in the dispatch state and the agent in the participant list shortly after the job process joined;
  the worker asks for its binding again within a bounded deadline.
* livekit-sip v1.18.0 names the room of an `individual` dispatch rule `<prefix>_<caller number>_<suffix>` (E.164,
  with `+`) and sets `sip.callID`, `sip.trunkID` and `sip.phoneNumber` on the SIP participant; the room configuration of
  the rule dispatches the agent (no explicit dispatch). Room names may therefore carry a caller number: the gateway
  keeps names only as digests, and deployments set `hidePhoneNumber` on dispatch rules (the media contracts accept any name the media plane assigns up to 256 characters). Its RTP ports (10000-10099)
  are reachable only inside the compose network, so the host-side SIP test covers
  signalling (INVITE, 200 OK once the runtime publishes, BYE) and the WebRTC caller covers audio both ways.
* Any holder of the local API key/secret can mint a participant of kind SIP with any attributes (a copied
  `sip.callID`) and rewrite attributes through UpdateParticipant: livekit-server does not distinguish livekit-sip's
  participants from minted ones. LiveKit API keys cannot be scoped, and the Agents worker needs the secret to register.
  The gateway pins each call to one room (`platform/src/calls/binding/store.ts` room claim) instead of trusting the
  attribute (Layer-2 `platform/test/integration/media/carrier.test.ts`).
* Right after StopEgress the egress API lists the egress as EGRESS_ENDING (still running) for up to a second; the
  readout stays STOPPING until a later reconciliation reads it COMPLETE.
* Egress refuses requests when it believes the host CPU is saturated; the local template lowers the track egress cost
  so a shared 4-CPU CI host still records.
* Per-track egresses of one room reach EGRESS_ACTIVE in no fixed order; tests wait for the specific egress.
* On a loaded shared host a bind can time out at the worker (5 s) while the gateway still works on it, and the worker's
  retry then races its own first bind. Starting a session supersedes the call's previous one, so the gateway creates
  a call's first record under a first-bind lease (`platform/src/calls/binding/store.ts`): the retry is refused
  retryably and, asked again, gets the same binding (seen once in the recording suite before the lease existed).

Ownership hand-off: a compose fragment `deploy/local/services/livekit-egress.compose.yaml` (profiles `media` and
`recording`, `network_mode: host`, the same pinned image and this template) is proposed for the services group; until
it exists the tests manage the container themselves.
