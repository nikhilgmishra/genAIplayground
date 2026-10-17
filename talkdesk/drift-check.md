# Configuration drift check (spec section 15, Phase 2)

Purpose: reconcile the **actual** Talkdesk tenant configuration against the repository's
definition (`expected-config.yaml`) so that what was tested is what is running. Status:
**UNVERIFIED** — no tenant configuration has been observed.

## 1. What is compared

Only the `tenantConfiguration` subtree of `expected-config.yaml`:

| Area | Expected source | Observed how |
|---|---|---|
| Tenant identity, plan, entitlements | UNKNOWN placeholders | tenant admin console (UI path to be confirmed) |
| Recording policy | `studio-flow-spec.md` SF-00/SF-04 | tenant recording settings |
| Destinations / queues | `DESTINATIONS` in `platform/src/fixtures/synthetic-world.ts` (validated by `tools/validate-package.mjs`) | queue configuration |
| Exit defaults | `studio-flow-spec.md` §4 | Studio flow |
| Studio flows, steps, variables, DTMF menus, HTTP steps | `studio-flow-spec.md` §2–§6 | Studio flow export or UI |
| AI agents, Skills, tools per agent, guardrail text hash, limits, version identity | `ai-agent-config.yaml` | AI Agent Platform configuration |
| MCP connection, session binding mode, catalogue digest | `mcp-connection.md` | MCP connection settings |
| Studio-played template texts (sha256) | approved template registry (`platform/src/voice`) | prompt texts in Studio |

## 2. How the actual configuration is obtained

Export method: **UNKNOWN** until Talkdesk documents one for the plan (VQ-TD-37). Do not
script undocumented endpoints or scrape the UI.

| Method | When | Record |
|---|---|---|
| Documented export or API (format, version, auth) | only after VQ-TD-37 is answered in writing | method, endpoint, version, auth mechanism, rate limits, data class and source document in this file's §5 log; convert the export into the observation format |
| Operator transcription | until then | copy `observed-config.template.yaml` **outside the repository**, fill each `UNOBSERVED` from the UI, keep a screenshot/export reference per section |

Rules for the observation file: synthetic sandbox facts only; no secrets (client secrets,
tokens), no PHI, no real phone numbers; paste guardrail and prompt texts exactly (no
trailing newline) — the tool derives hashes. Write `UNKNOWN` where the tenant does not
expose a value; leave `UNOBSERVED` where it was not checked.

## 3. Running the check

```
# (re)generate the template whenever expected-config.yaml changes
node talkdesk/tools/drift-check.mjs --emit-template > talkdesk/observed-config.template.yaml

# compare an observation (outside the repo) against the expected configuration
node talkdesk/tools/drift-check.mjs /secure/path/observed-sandbox-2026-10-17.yaml

# also compare the proposed telephony-control paths with the gateway OpenAPI, once published
node talkdesk/tools/drift-check.mjs /secure/path/observed.yaml --openapi <gateway-openapi.json|yaml>
```

Result statuses per field:

| Status | Meaning | Action |
|---|---|---|
| `MATCH` | observed equals expected | none |
| `DRIFT` | observed differs from a concrete expected value | fix the tenant **or** make a reviewed repository change; re-run affected tests |
| `UNEXPECTED` | observed field not in the expected definition | review; add to expected-config via reviewed change or remove from tenant |
| `NEW_FACT` | expected is a placeholder (UNKNOWN, UNDECIDED, `TO_BE_PINNED_*`, `TALKDESK_QUEUE_PLACEHOLDER_*`) and a tenant value was observed | reviewed change replaces the placeholder (queue refs flow to the config owner's `DestinationConfig`) |
| `UNOBSERVED` / `NOT_RECORDED` | not checked | observe it |

Verdict and exit code: `CLEAN` (0) only when every expected field is `MATCH`; `DRIFT` (1) if
any `DRIFT` or `UNEXPECTED`; `INCOMPLETE` (2) otherwise; 3 on a usage/parse error.
`INCOMPLETE` is never a pass (OPS-03). With the template unchanged the verdict is
`INCOMPLETE` by design.

## 4. When to run

* After applying or changing anything in the tenant (before any test run is counted).
* Before and after each Simulator batch and each PSTN test session.
* After any catalogue, template or guardrail change in the repository (tool definitions are
  not versioned inside Talkdesk, [S3]).
* Before a ReleaseManifest is assembled: `talkdeskConfigurationId` is recorded only with a
  `CLEAN` result from the same day.

## 5. Observation log

| Date (UTC) | Operator | Tenant | Method | Evidence ref | Verdict |
|---|---|---|---|---|---|
| — | — | — | — | — | NOT_RUN |
