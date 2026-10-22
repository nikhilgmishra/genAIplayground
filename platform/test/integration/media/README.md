# Layer-2 media suite (WP-11)

```bash
make up PROFILE=core,media          # livekit, livekit-sip, valkey, postgres, dynamodb, keycloak, ... (core is enough)
make test-integration SUITE=media                     # every file
make test-integration SUITE=media FILTER=recording    # recording control only (needs minio and the egress image)
```

Production code over real protocols (`support.ts`): the live gateway composition (`bootLive` over the composition
sandbox) with the media routes registered on its app, the CallBinding store on its own DynamoDB Local table, the
runtime credential issued by Keycloak (client credentials) and verified through the egress transport, the media-plane
lookup and supervisor over livekit-server's Twirp API, and the production media worker as its own process
(`media/test/support/run-worker.ts`). Synthetic callers are `@livekit/rtc-node` participants publishing a 440 Hz tone.
Test plumbing (labelled, not unit fakes): the HTTPS front of the gateway and the TLS proxy in front of Keycloak (test
PKI for the synthetic names), the throwaway egress container (`deploy/local/livekit/egress.yaml`, host network), and
the observation of the production audit sink and HandoffService (`stack.audits`, `stack.humanRoutes`: every event and
request still reaches the composition's own writer and service). A failed test prints the workers' output and the
gateway composition's warn/error log events (`stack.gatewayEvents()`, the memory logger's redacted fields). A worker
reports its load as calls / call slots (`maxConcurrentCalls`, default 4); a suite that keeps more calls open on one
worker raises the slots (`recording.test.ts`: 8), since livekit-server stops offering jobs to a worker whose load is high.

| File | Requirement ids | What runs |
|---|---|---|
| `worker.test.ts` | FO-10-01, FO-03-17, FO-03-18, FO-05-16, FO-19-10, FO-22-16, AUTH-03, SAFE-02 | the worker registers and receives the explicitly dispatched room job; audio both ways (the caller's tone reaches the runtime, the runtime's output reaches the caller); the binding names the room's interaction at generation 1; a SIGKILL of the worker's process group, the supervisor's re-dispatch, the replacement's re-bind with a new generation and fencing token; the crashed owner's claim refused (409); runtime-credential refusals (no token, a malformed one, a real Keycloak token of another client: 401 RUNTIME_CLIENT_UNKNOWN, one without the runtime scope: 403 RUNTIME_SCOPE_MISSING); the human and safety routes with no binding; the supervisor's human route for an unrecovered call |
| `carrier.test.ts` | FO-05-16, FO-10-46, AUTH-03, SAFE-02 | the attack itself against livekit-server: SIP-kind participants minted with the API secret carrying a victim's `sip.callID`; the worker's job in that second room refused BINDING_ROOM_MISMATCH (audited), its caller routed to a person under a fresh interaction, the victim's binding, generation and fencing token unchanged; the victim's call id rewritten through UpdateParticipant: the next bind refused BINDING_CARRIER_CHANGED, the binding revoked, the live owner routing the caller to a person |
| `sip.test.ts` | FO-03-17, FO-05-16, FO-10-09, FO-16-19, FO-19-10 | an INVITE from the harness SIP UA (`_harness/protocols.ts`) is matched by an inbound trunk; the dispatch rule's room configuration dispatches the worker, which binds the SIP call (carrier interaction = livekit-sip's `sip.callID`, generation 1, the caller number nowhere in the binding record, the readout or the worker's output); livekit-sip answers 200 OK once the runtime publishes; BYE ends the binding (the runtime's hang-up report; when the job process was lost at the hang-up, shown by a binding no longer renewed, the supervisor's end of the call, printed as a diagnostic; a live job that missed the hang-up fails the test) and the job leaves |
| `person.test.ts` | SAFE-02, FO-10-46, FO-10-09 | a caller who asked for a person is never handed back to the AI: the handoff store fails for the worker's whole human deadline (labelled failure injection on the production HandoffService), the worker leaves, and once the store recovers the supervisor routes the owed person for the call's interaction (never REDISPATCHED, no new binding); the person accepted and the worker host crashed: the supervisor leaves the caller with the person (WITH_PERSON), and a replacement job dispatched anyway is refused BINDING_WITH_PERSON and stays silent (HUMAN_ROUTED), with no new binding, generation or person; a person accepted for the room by another party (the session-less human route) while the AI owner holds the call: the owner's next heartbeat is refused BINDING_WITH_PERSON (audited) and it goes silent (HUMAN_ROUTED), no second person; the binding store unreadable (a DynamoDB table that does not exist) while a caller's runtime is gone: the supervisor sweeps PERSON_STATE_UNKNOWN, never re-dispatches (livekit-server lists one dispatch), and routes the caller to a person once at its deadline through the production HandoffService |
| `recording.test.ts` | FO-03-44, FO-10-46, DATA-03, SAFE-02, FAULT:RECORDING_REFUSED | UNKNOWN records nothing; GRANTED starts TrackEgress (checked through the egress API and the MinIO bucket); the caller's DTMF decline stops it (egress API: ended; readout: recording and transcription OFF; gateway: decline held, consent version advanced); the worker host crashes while it records and a recorder is started under the call's own path during the crash: the replacement adopts only the recorder the gateway names (its `media.recording.adopted` log), flags FOREIGN_RECORDER_ACTIVE (readout and gateway) and requests a person; the owner crashes after the caller's recording and AI-processing declines reached the gateway but before its stop reached the egress service: the replacement is refused BINDING_CONSENT_REQUIRES_PERSON, stops the owner's still-running recorder (egress API: ended), flags the recorder that is not the call's to the gateway (recorded and audited, never stopped by the runtime), and is with the person (CONSENT_DECLINED_ALTERNATIVE); a foreign egress next to the consented recorder is flagged (FOREIGN_RECORDER_ACTIVE) and recorded at the gateway, the worker requests a person (HandoffService: POLICY_REQUIRES_HUMAN for the call's interaction), its own egress ends (egress API) and its phase is HUMAN_ROUTED; a second worker with recording disabled sees a foreign egress through its observe-only client and routes the same way; the RECORDING_REFUSED seam declines at call start |

Emulator fidelity (recorded in `deploy/local/livekit/README.md`): livekit-server v1.13.9 does not move a dead
worker's room job to another worker; its Twirp JSON uses proto field names; a just-dispatched job and its agent are
listed a moment after the job process joined; ICE candidates are 127.0.0.1 (host-side participants only); livekit-sip
puts the caller's E.164 number into an `individual` rule's room name; its RTP ports are not published to the host
(SIP signalling only from the host-side UA). Not
emulated: carrier SIP trunks and PSTN codecs, TURN, real network loss, carrier DTMF and recordings, S3 Object Lock and
KMS for recordings.
