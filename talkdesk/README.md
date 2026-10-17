# Talkdesk configuration package

Status: **UNVERIFIED** — nothing in this directory has been applied to, exported from or
tested against any Talkdesk tenant (sandbox or production). Every Talkdesk behaviour
described here is either (a) a public-documentation claim from the source register
(S1–S6, S24) that must be re-validated in the tenant, or (b) a repository requirement
that the tenant must be shown to satisfy. Neither is evidence of tenant capability
(OPS-03). Release status of this package: `IMPLEMENTED_OFFLINE` (documents and offline
validators only). It is not `VERIFIED_SANDBOX`.

This package does not claim HIPAA compliance or production readiness.

## Why this is a specs-and-runbooks package

No public automation API for the AI Agent Platform Simulator, Studio flow publishing or
AI Agent configuration was established in the specification review (spec section 2,
[S1], [S4], [S6]). The repository therefore does **not** call any Talkdesk endpoint and
does **not** invent one. Configuration is applied by a Talkdesk administrator following
the operator-executable specifications below. If Talkdesk later documents a supported
import or API for the actual plan, the operator records the method, endpoint, version,
auth mechanism and source in `drift-check.md` before using it.

Where an exact Talkdesk UI path or component name is not established by the source
register, the documents say **"UI path to be confirmed from tenant documentation"** and
list what must be verified. Do not substitute a guessed label.

## Contents

| File | Purpose | Spec sections |
|---|---|---|
| `studio-flow-spec.md` | Deterministic Studio flow: disclosure, consent before recording, language, role, call start, Auth Gate initialisation, AI admission, independent human route, early safety branch, verification Skill, deterministic confirmation, transfer, continuity, call end | 3, 6, 7, 10, 11, 12 |
| `ai-agent-config.yaml` | Coordinator + bounded domain agents, allowed tools and versions, 300-character guardrail (counted), version identity = UNKNOWN | 2, 3, 8 |
| `mcp-connection.md` | Streamable HTTP connection to the gateway `/mcp`, service identities, OAuth2 vs static-bearer exception, TB-01 session-reference decision rule, ALB/WAF checks, catalogue pinning, rejections | 2, 3, 8 |
| `auth-gate.md` | How the Auth Gate variable is set from the gateway auth-gate response (strict boolean), AUTH-07 test matrix, gateway authority | 2, 7 |
| `simulator-and-evaluation-runbook.md` | Operator steps for Simulator chat/voice runs from `scenarios/`, version proof per run, EvaluationResult capture, Batch Agent Evaluation (Preview) caveats | 2, 14 |
| `capability-gate.md` | Section 3 vendor capability gate as a checklist mapped to TB-01..TB-10, evidence, status, launch consequence; LiveKit fallback decision criteria | 2, 3 |
| `vendor-questions.md` | Register of written questions (Talkdesk, Salesforce, IdP owners, AWS, speech/model vendors, ElevenLabs caveats, Nova 2.5 Sonic) with owner, status, gate | 2, 5 |
| `expected-config.yaml` | Repository's expected tenant configuration (destinations, variables, flows, Skills, exits, catalogue digest, guardrail hash) | 10, 15 |
| `drift-check.md` | Procedure to obtain the actual tenant configuration (method UNKNOWN) and diff it against `expected-config.yaml` | 15 |
| `observed-config.template.yaml` | Operator transcription template used when no documented export exists | 15 |
| `tools/` | Offline validators (`validate-package.mjs`, `drift-check.mjs`) and `node:test` suite | — |

Release-side material for execution-order step 5 (exact sandbox configuration,
approval requests, phase gates) lives in `docs/release/`.

## How this maps to the gateway

```
Talkdesk number ─► Studio flow (deterministic; talkdesk/studio-flow-spec.md)
                     │  HTTP steps, service identity "telephony_control"
                     │     ─► gateway telephony-control operations (TC-01..TC-12 below)
                     │  independent human route: Studio ─► Talkdesk queue (no gateway, model or policy call)
                     ▼
                  AI Agent Platform (untrusted conversational layer; talkdesk/ai-agent-config.yaml)
                     │  MCP Streamable HTTP, service identity "mcp_tools"
                     ▼
                  gateway /mcp (talkdesk/mcp-connection.md) ─► pinned catalogue ─► strict schema
                     ─► server-side session resolve ─► kill switch/admission ─► OPA ─► business op ─► audit
```

| Talkdesk-side element | Gateway element (repository) | Interface (read-only, owned elsewhere) |
|---|---|---|
| Studio call-start HTTP step | `telephony.startCall` | `SessionService.startCall` in `platform/src/identity/ports.ts`; `StartCallResult` |
| Auth Gate variable refresh | `telephony.authGate` | `SessionService.authGate` → `AuthGateResponse` (`platform/src/protocol/auth.ts`) |
| Role menu | `telephony.selectRole` | `SessionService.selectRole` |
| Consent change mid-call | `telephony.recordConsent` | `SessionService.recordConsent`; `ConsentState` |
| Isolated DTMF OTP (only if TB-03 proven) | `telephony.submitOtp` | `VerificationService.submitOtp` (telephony_control identity) |
| Deterministic confirmation step | `telephony.pendingConfirmation`, `telephony.confirmAction` | `ActionService.confirm` + `ActionConfirmation` (`platform/src/actions/ports.ts`) |
| Participant change (conference, transfer leg) | `telephony.applyChange` | `SessionService.applyChange` |
| Transfer state events (TB-07) | `telephony.transferEvent` | `TransferRecord` / `TransferState` (`platform/src/protocol/support.ts`) |
| AI admission check | `telephony.admission` | `AdmissionController.admit` (`platform/src/ops/ports.ts`) |
| Call end | `telephony.endCall` | `SessionService.endCall` |
| AI agent tool calls | `/mcp` | `ToolRequest`/`ToolResult`/`ToolDefinition` (`platform/src/protocol/tools.ts`) |
| Queue / destination mapping | trusted destinations | `DestinationConfig` (`platform/src/config/ports.ts`); `DESTINATIONS` (`platform/src/fixtures/synthetic-world.ts`) |

The telephony-control operation identifiers (`telephony.*`) and the HTTP paths quoted in
these documents are **PROPOSED** by this package. The gateway module's published OpenAPI
is authoritative; `drift-check.md` compares the two. Operations `telephony.admission`,
`telephony.pendingConfirmation` and `telephony.transferEvent` have no port method today
and are listed as interface change requests in the delivery report.

## Conventions

* Status vocabulary: `UNKNOWN`, `BLOCKED`, `UNANSWERED`, `UNVERIFIED`, `NOT_RUN`. None of
  these is equivalent to approved or PASS (OPS-03).
* Identifiers: destination ids `dst_*` come only from trusted configuration (SAFE-05).
  Talkdesk queue references stay as the `TALKDESK_QUEUE_PLACEHOLDER_*` values from
  `DESTINATIONS` until a reviewed tenant export exists.
* Phone numbers: none. Where an example is unavoidable, only fictional `+1 555 01xx`
  numbers are used. Tenant numbers are provisioned by the Talkdesk administrator under
  an approved scope (see `docs/release/approval-requests.md`).
* Secrets: none. Secret **names** only; owners create values in AWS Secrets Manager.
* Caller-facing wording: template ids only, resolved from the approved template registry
  (`platform/src/voice`, owner: voice module). The only literal caller text quoted is the
  spec section 11 opening template, which is itself marked as a template that does not
  replace the approved consent flow.

## Validation (offline)

```
node talkdesk/tools/validate-package.mjs     # YAML parse, guardrail length/hash, destination + tool consistency
node --test talkdesk/tools/                  # tagged node:test suite
node talkdesk/tools/drift-check.mjs talkdesk/observed-config.template.yaml   # example drift run (expected: every field UNOBSERVED)
```

These run without network access and without any Talkdesk credential.

## Source register used (reference, not proof of tenant capability)

* [S1] AI Agent Platform release notes — GA, Authentication Gate, Simulator limits, preview features.
* [S2] Authentication Gate — variable-based access, deterministic verification responsibilities.
* [S3] Build Skill MCP — Streamable HTTP, bearer or OAuth2, external tool definitions not versioned.
* [S4] Simulator — chat and voice settings, application input and scripts.
* [S5] Guardrail Customization — 300-character field, trigger limit can close a conversation.
* [S6] Agent Evaluation overview — Preview status, dataset behaviour.
* [S24] Explore API — historical report generation; each report's fields and restrictions inspected individually.

URLs are in `docs/spec/voice-support-specification.txt` section 17. Product details are
time-sensitive; re-read each source before enabling anything in a real tenant.
