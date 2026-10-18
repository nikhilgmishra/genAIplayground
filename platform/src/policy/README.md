# Policy module (`platform/src/policy`)

In-process OPA WebAssembly policy engine implementing the `PolicyEngine` port (`ports.ts`,
[ADR-0002](../../../docs/adr/ADR-0002-opa-wasm-in-process.md)), the policy input builder, the
workforce console decision contract, golden decision probes with the "no silent access
expansion" gate, and a test helper that builds the bundle. Rego sources, catalogue data and the
build script are in [`/policy`](../../../policy/README.md) and `scripts/policy.sh`.

Status: **IMPLEMENTED_OFFLINE**. No policy release is approved (PRQ-031).

## What is implemented

| File | Responsibility |
|---|---|
| `engine.ts` | `OpaWasmPolicyEngine.load({bundleDir, expectedVersion, expectedDigest})` reads `bundle.tar.gz`, computes `bundleDigest` (sha256), checks `bundle.sha256`, reads `policy.wasm` / `data.json` / `.manifest` **from the archive** (extracted copies must match), validates the manifest (both entrypoints, revision = `policyVersion`) and the catalogue, loads the WASM with bounded memory. `decide()` / `decideSync()` and `decideConsole()` / `decideConsoleSync()` never throw. `FailClosedPolicyEngine` and `loadPolicyEngineOrFailClosed()` for startup without a bundle. `withOptions()` for clock/logger/metrics |
| `input.ts` | `buildPolicyInput({auth, action, purpose, tool, resource, relationships, killSwitches, environment, now})`: strictly re-parses the trusted `AuthContext`, relationship facts and resource; maps only server-established fields; `auth: null` yields an unauthenticated, already-expired auth block (safety/human still allowed) |
| `console.ts` | `ConsoleDecisionInput` / `ConsoleDecision` schemas and `buildConsoleInput()` |
| `catalogue.ts` | Strict schema for `data.vsp.catalogue` plus structural invariants (exemptions only for safety/human; mutations are WRITE class with confirmation; commits need a digest; sensitive actions need a relationship and A2+; partner paths organization-only; auditor never on mutating console actions) |
| `tar.ts` | Bounded tar.gz reader (checksums, PAX paths, no links, no traversal, size and entry limits) |
| `golden.ts` | Probe/approval schemas, `compareProbe`, `expansionKinds`, `findExpansions`, `resolveApprovedExpansions`, stable serialization, `evaluateProbe` |
| `golden-matrix.ts` | Declarative probe matrix (SYNTHETIC identities) and `generateProbes()` |
| `golden-generate.ts` | CLI: check (default), `--update` (refuses unapproved expansions), `--gate <baseline>` |
| `ensure-bundle.ts` | TEST/DEV helper: `ensurePolicyBundle()` runs `scripts/policy.sh build` when `policy/build` is missing or `sources.sha256` is stale; `computeSourcesDigest()` matches the script |
| `fixtures/inputs.fixture.ts` | LOCAL FIXTURE builders for SYNTHETIC inputs used by the tests |

### Engine guarantees

* Invalid input (unknown field such as `callerClaimedRole`, bad enum, bad id, oversized input over
  64 KiB, unparseable timestamp) -> deny `POLICY_INPUT_INVALID` (AUTH-03).
* Evaluation error, malformed or empty result set, broken clock -> deny `POLICY_ENGINE_ERROR`.
* Timestamps are normalized to canonical millisecond UTC before evaluation (the Rego parses only
  that form). Sub-millisecond digits are truncated.
* A TypeScript invariant guard can only **tighten** a WASM decision: an allow with a revoked or
  expired session, tenant mismatch, AI-admission switch, writes switch on a WRITE action,
  `VERIFICATION_SECRET` resource, uncatalogued action or a field mask wider than the catalogue
  becomes `POLICY_ENGINE_ERROR`. Safety/human routes are exempt from the guard.
* More than 16 reason codes: the first 15 (sorted) plus `REASON_CODES_TRUNCATED`; still a deny.
* Logs are content-free (`action`, `allow`, first reason code, decision id, version); metric
  `vsp_policy_decisions_total{allow,consequential}`. Measured locally: about 0.25 ms per decision.

## Integration notes for other modules

* Tool `permissions` must use the catalogue action names (`appointment:prepare_change`, not
  `appointment:prepare`; `human:request`, not `handoff:request`; `billing:submit_review`; public
  FAQ search is `public:read`). Resource `type` values must be one of the action's
  `resourceTypes`.
* Relationships come from `RelationshipDirectory.relationshipsFor(actorId, selectedRole)`,
  including the `self` fact (source `identity_provider`); self paths do not require a scope,
  delegated/representative/treating paths require the action name as scope.
* Treat a `ValidationError` from `buildPolicyInput` as a denial.
* Safety and human routing must not depend on `decide()` succeeding (independent Studio route,
  spec section 3). With a valid input they are always allowed; an invalid input or a missing
  bundle denies everything, including them.
* `killSwitches.aiAdmission = true` denies every non-exempt action, including those of sessions
  already in progress. `ops/kill-switches.ts` applies AI admission only to new sessions; the
  gateway decides which value to pass (see the report).
* Pin `engine.policyVersion` / `engine.bundleDigest` in configuration (`policy.expectedVersion`,
  `policy.expectedDigest`) and the ReleaseManifest; pass them to `load()`.

## LOCAL FIXTURE

`fixtures/inputs.fixture.ts`, the golden matrix identities, and the SYNTHETIC approval record
written to a temp directory by `golden-gate.test.ts` are test fixtures. No real person, PHI or
approval exists here. The engine itself (`kind: "live"`) is the real implementation.

## BLOCKED

* Approved policy release (PRQ-031), consent semantics (PRQ-026), minors/representatives
  (PRQ-027) and assurance per action (PRQ-030): see [`/policy/README.md`](../../../policy/README.md).

## How to test

```bash
bash scripts/fetch-tools.sh            # pinned OPA, once
bash scripts/policy.sh test            # Rego: fmt, check --strict, 211 opa tests
cd platform
npx vitest run src/policy              # 849 tests (builds policy/build when stale)
npx tsc -p tsconfig.json --noEmit
npx eslint src/policy
```

## Requirement IDs enforced or evidenced

AUTH-02 (deny by default, every protected action decided here), AUTH-03 (strict
server-established input), AUTH-04 (expiry/revocation in policy and in the TS guard), AUTH-05
(relationship facts, partner and provider limits, representatives), AUTH-06 (verification
secrets never through tools), SAFE-02 (safety/human always allowed), DATA-01 (field masks),
DATA-03 (consent defaults), ACT-01 (digest-bound commit, confirmation obligation, A3 step-up),
OPS-03 (missing inputs and unrun builds fail, never pass), OPS-06 (pinned version and digest),
SPEC-14 policy-expansion gate, SPEC-7 staff role separation, MFA and break-glass, SPEC-13 kill
switches.
