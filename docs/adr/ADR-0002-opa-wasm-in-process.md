# ADR-0002 OPA policy evaluated in-process via WebAssembly, with a golden-probe expansion gate

| Field | Value |
|---|---|
| Status | **Accepted for engineering**. Each policy bundle used outside local/CI: **Pending human approval** (`POLICY_RELEASE`, PRQ-031) |
| Date | 2026-10-17 |
| Decided by | Principal engineer (coding agent) for the engineering scope only |
| Approval needed from | Policy approver and security leadership, per bundle version |
| Related prerequisites | PRQ-031, PRQ-030 |

## Context

Spec section 3 selects OPA policy bundles "evaluated locally beside the tool service", deny by
default, checking role, relationship, scope, action, assurance and purpose. Spec section 14
requires that "a policy update cannot silently expand access". The service is TypeScript on
Node 22; OPA itself is a Go program. Options to evaluate Rego locally are an OPA sidecar
(REST over localhost) or a bundle compiled to WebAssembly and evaluated in-process.

## Decision

1. Rego source lives in `policy/`; the bundle is compiled to WebAssembly with the pinned OPA
   binary (`.tools/opa`, version 1.21.0, checksum-verified by `scripts/fetch-tools.sh`) and
   evaluated in the gateway process through `@open-policy-agent/opa-wasm` 1.10.0, behind the
   `PolicyEngine` port (`platform/src/policy/ports.ts`).
2. `PolicyEngine.decide` never throws: any load or evaluation error yields
   `allow=false` with reason `POLICY_ENGINE_ERROR`. Missing input fields deny.
3. Policy input is the strict `PolicyInput` (`platform/src/protocol/policy.ts`): only
   server-established `AuthContext` fields, authoritative relationship facts and resource
   descriptions from authoritative lookups. Time is passed as `now`; the policy makes no
   network calls (no `http.send`).
4. The bundle's sha256 (`bundleDigest`) and `policyVersion` are pinned in configuration and in
   the `ReleaseManifest`; the production guard rejects unknown policy versions (OPS-04).
   Bundles are loaded at startup from the release artifact, never downloaded dynamically.
5. **Golden decision probes are authoritative.** A versioned set of probe inputs with expected
   allow/deny and reason codes runs against the Rego (`opa test`) and against the compiled
   WASM build in vitest, so the two cannot diverge.
6. **Expansion gate**: CI compares the allow set of the candidate bundle over the probe corpus
   with the previous approved bundle. Any probe that changes from deny to allow, any widened
   field mask and any removed obligation fails the gate unless the change is listed in the
   policy change record and the release is approved (`POLICY_RELEASE`). New probes are added
   for every new tool, action or relationship type. The procedure is in
   [`../RUNBOOKS/policy-release.md`](../RUNBOOKS/policy-release.md).

## Consequences

* No extra container, port or network hop on the critical path; a policy outage cannot occur
  independently of the gateway, and the gateway's fail-closed rule covers engine errors.
* Some OPA built-ins are unavailable in WebAssembly; the policy must stay within the supported
  subset. This is acceptable because network and non-deterministic built-ins are unwanted.
* Decision logs are produced by the gateway (audit events with decision id, policy version and
  reason codes), not by OPA's own decision-log plugin.
* Policy changes require a release; there is no hot reload in production.
* The permission matrix ([`../security/permission-matrix.md`](../security/permission-matrix.md))
  is a human-readable summary; where it differs from the Rego and its golden probes, the
  probes are authoritative and the matrix must be corrected.

## Alternatives considered

| Alternative | Why not adopted |
|---|---|
| OPA sidecar over localhost REST | Extra process to secure, scale and monitor; adds latency and an availability coupling; native decision logs would need PHI review |
| Remote policy service | A network dependency for every tool call; spec asks for local evaluation |
| Hand-written TypeScript authorization | Not separately reviewable by policy approvers; harder to prove "no silent expansion" |
| Other policy languages (for example Cedar) | Spec selects OPA; no repository constraint justified a change |

## Linked requirements

AUTH-02, AUTH-05, OPS-04, OPS-06, SPEC-3 (policy enforcement), SPEC-14 (policy update cannot
silently expand access).

## Revisit when

The supported WebAssembly built-in subset blocks a required rule, or measured evaluation
latency at the tested load (at least 400 sustained tool requests per second, illustrative) is
unacceptable.
