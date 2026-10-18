# Voice support platform (offline vertical slice)

Administrative voice support for a mental-healthcare organisation: **Talkdesk** owns telephony and
the conversational layer, an **AWS control plane** in this repository owns identity, policy, actions,
audit and workflows, and **Salesforce Service Cloud** is the system of record. The specification this
implements is [`docs/spec/voice-support-specification.txt`](docs/spec/voice-support-specification.txt).

> **Status: `IMPLEMENTED_OFFLINE` only.** Everything runs against labelled LOCAL FIXTURE adapters
> and SYNTHETIC data on loopback. Nothing has been verified against Talkdesk, Salesforce, an identity
> provider, AWS or a telephone network. Vendor sandbox, pilot and production work is BLOCKED on the
> prerequisites in [`docs/PREREQUISITES.md`](docs/PREREQUISITES.md), all of which are `UNKNOWN` or
> `BLOCKED`. This is not a claim of HIPAA compliance or production readiness, and no approval has
> been granted or fabricated.

## Layout

| Path | Content |
|---|---|
| `platform/` | Control plane (TypeScript, Fastify, MCP Streamable HTTP): gateway, identity, policy, actions ledger, audit, workflows and transfer, safety, voice templates, knowledge, memory, retention, console API, worker, evaluation. Module READMEs under `platform/src/*/README.md` |
| `console/` | Operations and incident console (React 19, Vite) |
| `policy/` | OPA Rego authorization policy, compiled to WebAssembly and evaluated in process |
| `schemas/` | Generated JSON Schemas for the protocol, tool catalogue and OpenAPI |
| `talkdesk/` | Expected Talkdesk configuration, Auth Gate and Studio flow specs, capability gates and vendor questions |
| `infra/` | Terraform modules and environments (validated offline only) and generated Step Functions ASL |
| `scenarios/` | Evaluation corpus: journeys, generated variants and UNREVIEWED risk drafts |
| `knowledge/` | SYNTHETIC knowledge fixtures (no approved corpus exists) |
| `docs/` | Architecture, decisions, prerequisites, traceability, test evidence, runbooks, threat model, privacy, release pack |
| `evidence/` | Committed LOCAL FIXTURE evidence: corpus aggregates, demo transcripts, load records, test reports |

## Getting started

Requirements: Node.js 22.12 or later (below 23), pnpm 10.28 and Python 3 (capacity model only).

```bash
pnpm install --frozen-lockfile
bash scripts/fetch-tools.sh     # pinned OPA and Terraform into .tools/ (checksum verified)
```

### Run it locally

```bash
pnpm start                      # LOCAL FIXTURE gateway 127.0.0.1:8080, worker health :8081, console API :8090
cd console && npx vite          # console on 127.0.0.1:5173 (proxies /console/api to :8090)
```

`pnpm start` prints the LOCAL FIXTURE banner with the synthetic integration tokens. Data is in
memory (PGlite) and is gone when the process stops. The deployed entry point refuses fixtures
outside `local` and `ci` through the production configuration guard.

### Demo

```bash
pnpm demo                       # the nine journeys, with caller-heard lines, template ids and backend state
pnpm demo -- --faulted          # plus the fault-injected journeys
pnpm demo -- --transport mcp    # tools over the real MCP SDK client
```

The conversational side of the demo is the **LOCAL SIMULATED COORDINATOR**: deterministic keyword
rules, not a language model. Every caller-facing template is still `PENDING` or `DRAFT`
(clinical and legal review: PRQ-008, PRQ-028).

### Tests and gates

```bash
pnpm lint && pnpm typecheck && pnpm test            # platform and console
pnpm policy:test                                    # OPA fmt, strict check, policy tests
bash scripts/terraform-check.sh                     # fmt, validate and plan tests on mock providers
bash scripts/terraform-policy.sh test               # infrastructure policy tests
cd platform && pnpm run catalog:check && pnpm run openapi:check && pnpm run schemas:check \
  && pnpm run asl:check && pnpm run contracts:check && pnpm run scenarios:check   # generated-file drift
```

CI runs the same gates plus secret scanning and an SBOM ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
The evaluation corpus, traceability matrix and release manifest commands are in
[`docs/TEST_EVIDENCE.md`](docs/TEST_EVIDENCE.md) and [`docs/requirements/README.md`](docs/requirements/README.md).

## Where to read next

- [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md): what is implemented, how it was verified, what is blocked.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md): design and ADRs.
- [`docs/REQUIREMENTS_TRACEABILITY.md`](docs/REQUIREMENTS_TRACEABILITY.md): every invariant and requirement mapped to code, tests and results.
- [`docs/TEST_EVIDENCE.md`](docs/TEST_EVIDENCE.md): test, corpus, demo and load results, with their limits.
- [`docs/PREREQUISITES.md`](docs/PREREQUISITES.md): what each owner must supply or approve next.
- [`docs/security/`](docs/security/threat-model.md), [`docs/privacy/`](docs/privacy/data-flow-inventory.md), [`docs/RUNBOOKS/`](docs/RUNBOOKS/README.md).

## License

[MIT](LICENSE)
