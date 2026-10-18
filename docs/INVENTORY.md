# Repository inventory

Concise inventory for discovery (spec execution order step 1, spec section 15 phase 0). Snapshot
taken 2026-10-17 in the development sandbox. It records facts observed in this repository and
environment only; no production or vendor account was inspected.

## 1. Initial state

| Item | Observation |
|---|---|
| First commit | `f50b2ab` "Initial commit": `README.md` (one line, project title) and `LICENSE` (MIT, copyright Nikhil Mishra) |
| Existing services, workflow engine, database, message bus, CI, infrastructure | None. No existing production system to preserve, so the default architecture applies ([ADR-0001](adr/ADR-0001-default-architecture.md)) |
| Repository instructions | None beyond the specification supplied in `docs/spec/voice-support-specification.txt` |

## 2. Current layout

Modules follow [`ARCHITECTURE.md`](ARCHITECTURE.md) section 2. Implementation is in progress by
several engineers in parallel; per-module status lives in
[`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

| Path | Content |
|---|---|
| `platform/` | TypeScript control plane (`@vsp/platform`): protocol schemas, db, observability, config, resilience, ops, policy, identity, actions, outbox, audit, adapters, workflows, safety, voice, knowledge, memory, retention, business, gateway, console-api, evaluation, demo, main, fixtures |
| `platform/migrations/` | Ordered SQL migrations (module-numbered) with row-level security |
| `platform/config/` | Environment configuration files (`local`, `ci`, `sandbox`, `staging`, `production`) |
| `console/` | React + TypeScript operations console (`@vsp/console`) |
| `schemas/protocol/` | JSON Schemas generated from the protocol zod schemas |
| `policy/` | OPA Rego bundle and golden decision tests (policy module) |
| `infra/terraform/` | Terraform modules and per-environment stacks (`sandbox`, `staging`, `production`, `production-dr`); plan only |
| `infra/stepfunctions/` | Generated Step Functions Standard ASL documents and digest manifest |
| `talkdesk/` | Talkdesk Studio / AI Agent configuration specifications, vendor questions, capability gate and operator runbooks |
| `approvals/` | Human approval records (none exist; the coding agent cannot create them) |
| `scenarios/`, `evidence/` | Scenario corpus and evidence output locations |
| `scripts/` | `fetch-tools.sh` (pinned tools), `terraform-mirror.sh` (offline provider mirror), `terraform-check.sh`, `terraform-plan-offline.sh`, `terraform-policy.sh` (infrastructure gates), `ci/` (SBOM, secret scanning, metric and release-manifest checks), `capacity_model.py` (illustrative capacity model) |
| `.github/workflows/` | `ci.yml`, `deploy.yml`, `release.yml` (actions referenced by tag pending SHA pinning, PRQ-041; no run evidence yet) |
| `docs/` | Status, prerequisites, decisions, threat model, privacy, capacity, integrations, runbooks, release pack |

## 3. Toolchain (pinned)

| Tool | Version | Pin location | Notes |
|---|---|---|---|
| Node.js | 22.22.0 | `.nvmrc`; `engines.node` `>=22.12 <23` in `package.json` | LTS line |
| pnpm | 10.28.0 | `packageManager` in `package.json` | Workspace: `platform`, `console` (`pnpm-workspace.yaml`); lockfile `pnpm-lock.yaml` |
| TypeScript | 6.0.3 | `platform/package.json`, `console/package.json` | Strict, `noUncheckedIndexedAccess` (`tsconfig.base.json`) |
| Vitest | 4.1.12 | both packages | Test runner |
| ESLint / typescript-eslint | 10.13.0 / 8.71.2 | both packages | `console.log` banned outside CLI/demo entry points |
| tsx | 4.23.15 | `platform/package.json` | Local start, demo, generators |
| Vite | 8.3.2 | `console/package.json` | Console build |
| OPA | 1.21.0 | `scripts/fetch-tools.sh` (SHA-256 pinned) | Installed at `.tools/opa` (gitignored) |
| Terraform | 1.16.4 | `scripts/fetch-tools.sh` (SHA-256 pinned) | Installed at `.tools/terraform` |
| Terraform provider hashicorp/aws | 6.67.0 | `scripts/terraform-mirror.sh` (signed SHA256SUMS + pinned SHA-256) | Offline filesystem mirror at `.tools/tf-mirror` |
| Python | 3.13.16 (system) | not pinned | Used only by `scripts/capacity_model.py` (standard library only) |

## 4. Runtime dependencies and licences

Exact versions from `platform/package.json` and `console/package.json`; licences as reported by
`pnpm licenses list --json` run from the repository root on 2026-10-17.

### Platform (`@vsp/platform`, licence MIT)

| Package | Version | Licence | Purpose |
|---|---|---|---|
| `@aws-sdk/client-dynamodb`, `client-kms`, `client-s3`, `client-secrets-manager`, `client-sfn`, `client-sqs`, `lib-dynamodb` | 3.1152.0 | Apache-2.0 | AWS service clients (live adapters) |
| `@electric-sql/pglite` | 0.3.15 | Apache-2.0 | PostgreSQL in WebAssembly for offline tests ([ADR-0004](adr/ADR-0004-pglite-aurora-dynamodb.md)) |
| `@fastify/helmet` | 13.2.0 | MIT | Security headers |
| `@fastify/rate-limit` | 11.2.1 | MIT | Rate limiting |
| `@fastify/static` | 10.1.6 | MIT | Static assets (console) |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT | MCP Streamable HTTP adapter |
| `@open-policy-agent/opa-wasm` | 1.10.0 | Apache-2.0 | In-process policy evaluation ([ADR-0002](adr/ADR-0002-opa-wasm-in-process.md)) |
| `@opentelemetry/api` | 1.9.1 | Apache-2.0 | Metrics and tracing API |
| `ajv` / `ajv-formats` | 8.20.0 / 3.0.1 | MIT | JSON Schema validation |
| `fastify` | 5.12.7 | MIT | HTTP server |
| `jose` | 6.2.12 | MIT | JWT/JWKS (OIDC, assertions) |
| `pg` | 8.23.1 | MIT | Aurora PostgreSQL driver |
| `pino` | 10.4.0 | MIT | Structured logging (content-free wrapper) |
| `yaml` | 2.9.1 | ISC | YAML parsing |
| `zod` | 4.6.7 | MIT | Strict protocol schemas |

### Console (`@vsp/console`, licence MIT)

| Package | Version | Licence |
|---|---|---|
| `react`, `react-dom` | 19.3.1 | MIT |
| `react-router-dom` | 7.18.4 | MIT |

### Development dependencies (direct)

All MIT or Apache-2.0 except `axe-core` 4.14.0 (MPL-2.0, console accessibility tests). Direct
dev dependencies: `@eslint/js` 10.0.1, `@types/node` 22.20.5, `@types/pg` 8.23.1,
`@vitest/coverage-v8` 4.1.12, `asl-validator` 4.0.0 (Apache-2.0), `autocannon` 8.0.0, `eslint`
10.13.0, `fast-check` 4.10.2, `globals` 17.13.0, `tsx` 4.23.15, `typescript` 6.0.3 (Apache-2.0),
`typescript-eslint` 8.71.2, `vitest` 4.1.12, `@testing-library/jest-dom` 6.9.1,
`@testing-library/react` 16.3.3, `@testing-library/user-event` 14.6.8, `@types/react` /
`@types/react-dom` 19.3.0, `@vitejs/plugin-react` 6.1.2, `axe-core` 4.14.0, `jsdom` 30.1.3, `vite` 8.3.2.

### Licence summary (`pnpm licenses list --json`)

| Scope | Packages | Licences |
|---|---:|---|
| All (production + development) | 463 | MIT 351, Apache-2.0 57, ISC 19, BSD-3-Clause 12, BSD-2-Clause 10, BlueOak-1.0.0 5, MPL-2.0 4, MIT-0 2, CC0-1.0 1, (MIT AND Zlib) 1, 0BSD 1 |
| Production only (`--prod`) | 208 | MIT 146, Apache-2.0 38, ISC 12, BSD-3-Clause 5, BlueOak-1.0.0 5, BSD-2-Clause 1, 0BSD 1 |

**Non-permissive licences recorded** (all development-only; none in the production dependency tree):

| Package | Version | Licence | Pulled in by | Note |
|---|---|---|---|---|
| `axe-core` | 4.14.0 | MPL-2.0 | `console` devDependency | File-level weak copyleft; used unmodified as test tooling |
| `lightningcss`, `lightningcss-linux-x64-gnu`, `lightningcss-linux-x64-musl` | 1.33.0 | MPL-2.0 | `vite` 8.3.2 (console and vitest tooling) | Build tooling; not shipped in the runtime image |
| `pako` | 1.0.11 | (MIT AND Zlib) | `autocannon` → `hdr-histogram-js` (load-test tooling) | Permissive; listed because it is a compound expression |

Legal review of these entries is part of procurement and supply-chain review; engineering has
recorded them, not approved them. Rule: no new dependency without recording version and licence
here (`ARCHITECTURE.md` convention 11).

## 5. Environment constraints observed (development sandbox)

| Constraint | Observation | Consequence |
|---|---|---|
| Docker | CLI present; **no Docker daemon** | No container builds, image digests or containerised PostgreSQL here; base image digest BLOCKED (PRQ-042) |
| PostgreSQL for tests | Real PostgreSQL semantics via **PGlite** (WebAssembly) | [ADR-0004](adr/ADR-0004-pglite-aurora-dynamodb.md); Aurora behaviour unverified until a sandbox |
| `registry.terraform.io` | Reported blocked by the coordinator for this workflow; a metadata request from this session returned HTTP 200 at inventory time | The repository does not depend on it: `scripts/terraform-mirror.sh` builds a checksum- and signature-verified offline mirror and `terraformrc` disables direct installation of hashicorp/aws |
| `api.github.com` | Reported blocked by the coordinator; repository API calls from this session were refused by the session proxy policy | GitHub Action SHAs cannot be resolved here (PRQ-041) |
| Reachable | npm registry; GitHub release downloads; `releases.hashicorp.com` | Pinned tools fetched with checksum verification |
| `gpg` / `gpgv` | Installed | `terraform-mirror.sh` can verify the HashiCorp signature |
| Vendor tenants, AWS accounts, IdPs, Salesforce | None available | All live integrations BLOCKED ([`PREREQUISITES.md`](PREREQUISITES.md)) |

## 6. Secrets

**Secrets: none present; none printed.** No `.env` files exist. A pattern scan of
repository-authored files (excluding `node_modules`, `.git` and downloaded tool binaries in
`.tools`) for AWS access key ids, private key blocks, Slack and GitHub tokens, generic API keys,
`aws_secret_access_key` and quoted `client_secret` values found no matches; only file names were
printed, never matched content. Configuration carries secret **references** only
(`credentialRef`, Secrets Manager ARNs); synthetic fixtures use `*.local.invalid` issuers and
fictional 555-01xx caller numbers.

## 7. Reproduce this inventory

```bash
node --version && pnpm --version && .tools/opa version && .tools/terraform version
pnpm licenses list --json          # all dependencies
pnpm licenses list --json --prod   # production dependencies only
pnpm why lightningcss -r && pnpm why pako -r && pnpm why axe-core -r
```
