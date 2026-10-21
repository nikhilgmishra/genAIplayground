# Authorization policy bundle (`policy/`)

Status: **IMPLEMENTED_OFFLINE**. The bundle builds and is tested locally with SYNTHETIC
fixtures only. A built bundle is **not** an approved policy release: every bundle used outside
local/CI needs a `POLICY_RELEASE` approval record (PRQ-031, policy approver plus security
leadership; see [`../docs/RUNBOOKS/policy-release.md`](../docs/RUNBOOKS/policy-release.md)).
The coding agent cannot create that record. Nothing here claims HIPAA compliance or
production readiness.

## Layout

| Path | What it is |
|---|---|
| `VERSION` | Bundle revision (`YYYY.MM.DD-N`), written into the bundle manifest by `opa build --revision` and reported by the engine as `policyVersion` (OPS-06) |
| `wasm-capabilities.json` | Builtins the `@open-policy-agent/opa-wasm` 1.10.0 SDK implements, plus the `rego_v1` feature. `opa check` and `opa build` use it so the policy cannot call a builtin the in-process engine lacks (`time.parse_rfc3339_ns` is **not** available) |
| `vsp/data.json` | Versioned action catalogue: `data.vsp.catalogue` (see below) |
| `vsp/authz.rego` | Caller-facing entrypoint `vsp/authz/decision` |
| `vsp/console.rego` | Workforce console entrypoint `vsp/console/decision` |
| `vsp/lib.rego` | WASM-safe helpers: pure-Rego RFC 3339 parser (canonical `YYYY-MM-DDTHH:MM:SS.sssZ` only), assurance ranks |
| `vsp/*_test.rego` | `opa test` unit tests (252 results, counting each case of the data-driven console read role-set test, which pins every non-mutating console action of the catalogue) and SYNTHETIC fixtures; excluded from the bundle |
| `golden/probes.json` | 916 golden decision probes generated from a declarative matrix (`platform/src/policy/golden-matrix.ts`) |
| `golden/approved-expansions.json` | Approved access expansions (`[]`; entries `{probeId, approvedBy, approvalId, reason}`) |
| `build/` | Build output (gitignored): `bundle.tar.gz`, `policy.wasm`, `data.json`, `.manifest`, `bundle.sha256`, `sources.sha256` |

## Commands

```bash
bash scripts/fetch-tools.sh        # pinned OPA 1.21.0 (checksum-verified) into .tools/
bash scripts/policy.sh test        # opa fmt check + opa check --strict (WASM capabilities) + opa test -v --timeout 60s
bash scripts/policy.sh build       # WASM bundle into policy/build (skipped when sources.sha256 is fresh)
bash scripts/policy.sh rebuild     # force a build
bash scripts/policy.sh digest      # sources digest
bash scripts/policy.sh coverage    # opa test --coverage summary (authz 96.3%, console 94.5%, lib 97.2% at 2026.10.17-1)

cd platform
npx vitest run src/policy                              # engine, golden probes, expansion gate, properties
npx tsx src/policy/golden-generate.ts                  # check: probes.json up to date and satisfied by the bundle
npx tsx src/policy/golden-generate.ts --update         # regenerate probes; refuses unapproved expansions
npx tsx src/policy/golden-generate.ts --gate <baseline-probes.json>   # CI expansion gate vs an approved baseline
```

The build is reproducible: rebuilding unchanged sources yields the same `bundle.sha256`.

## Decision contract

`vsp/authz/decision` takes exactly `PolicyInput` (`platform/src/protocol/policy.ts`) and returns
`{allow, reasonCodes[], fieldMask[], obligations[]}` (sorted). The TypeScript engine adds
`decisionId`, `policyVersion` and `evaluatedAt`. Rules, in order of precedence:

1. **Always available (SAFE-02).** `safety:route` and `human:request` are allowed for any input:
   any role or none, A0, revoked or expired session, consent declined, every kill switch, budget,
   risk flags, tenant mismatch. The exemption list is fixed in Rego; catalogue data cannot add to
   it (catalogue lint and the TypeScript catalogue validator both reject that).
2. **Deny by default (AUTH-02).** Unknown action: `ACTION_UNKNOWN` + `DEFAULT_DENY`. Any other
   denial with no specific reason: `DEFAULT_DENY`. Every applicable deny reason is reported.
3. **Global denials** (all non-exempt actions): `SESSION_INVALID` (revoked, or `expiresAt <= now`,
   AUTH-04), `TENANT_MISMATCH`, `ROLE_NOT_SELECTED` / `ROLE_NOT_PERMITTED`, `PURPOSE_NOT_PERMITTED`,
   `CLASSIFICATION_NOT_PERMITTED`, `RESOURCE_TYPE_NOT_PERMITTED`, `VERIFICATION_SECRET_PROHIBITED`
   (all environments, AUTH-06), `CONSENT_DECLINED_ALTERNATIVE_ROUTE`, `CONSENT_NOT_ESTABLISHED`,
   `RISK_FRAUD_REVIEW`, `RISK_ACCOUNT_RECOVERY_IN_PROGRESS`, `RISK_PARTICIPANT_CHANGED`,
   `SAFETY_MODE_MUTATIONS_REVOKED`, `KILL_SWITCH_AI_ADMISSION|WRITES|INTENT|INTEGRATION`,
   `ACTION_DIGEST_REQUIRED`, `HUMAN_BOUNDARY`, `PARTNER_NO_INDIVIDUAL_ACCESS`.
4. **Access paths.** Each catalogue action lists paths (`open`, `self`, `representative`,
   `treating_provider`, `practice`, `partner`). A relationship fact counts only when
   `fact.actorId == auth.actorId`, the fact type is valid for the *selected* role (privileges of
   a multi-role user are never combined), the source is the authoritative registry for that type,
   it targets exactly the resource subject or organization, it is unexpired, it carries the
   path's scope, and it has no `MINOR_CONFIDENTIALITY_REVIEW` / `CUSTODY_DISPUTE` constraint
   (those deny with `REQUIRE_HUMAN`; `AUTHORIZATION_EXPIRED` likewise). Organization paths never
   reach an individual's record. `self` additionally needs `auth.subjectId == resource.subjectId`.
5. **Assurance.** Required tier is `max(tool.minAssurance, action minimum, path minimum)`. A3 is
   transaction-bound: it counts as A3 only when `auth.stepUpDigest == resource.actionDigest` and
   `stepUpExpiresAt > now`; otherwise the session counts as A2 (`STEP_UP_REQUIRED`,
   `STEP_UP_DIGEST_MISMATCH`, `STEP_UP_EXPIRED` + `REQUIRE_STEP_UP`).
6. **Allow output.** Field mask = the action's minimum field list; obligations from the catalogue
   (`AUDIT_READ`, `REQUIRE_CONFIRMATION`, `RESTRICTED_RECORD`). Deny output: empty field mask;
   `REQUIRE_HUMAN` / `REQUIRE_STEP_UP` derived from the reasons.

Every negated check goes through a positive helper rule: in Rego `not f(ref)` with an undefined
`ref` is itself undefined, so a missing input field always denies. Anything other than an
explicit `false` kill switch counts as engaged.

### Policy defaults pending human decisions (documented, not approved)

* **Consent (PRQ-026, privacy counsel).** If recording or automated processing is `DECLINED`, only
  safety, human, public (`PUBLIC_READ`) and intake (`INTAKE`) actions are allowed, with
  `REQUIRE_HUMAN` (approved alternative = a person). `UNKNOWN` processing consent is never consent:
  other actions deny with `CONSENT_NOT_ESTABLISHED` until the consent flow has run.
* **Minors and representatives (PRQ-027).** Constraints force human review; scopes must match.
* **Assurance tiers (PRQ-030).** Protected reads and ordinary mutations at A2; A3 only where the
  pinned tool catalogue declares it. Proposed engineering values, not an identity risk assessment.
* **Console.** Break-glass maximum 4 hours, workforce authentication maximum age 12 hours,
  5-minute clock skew: proposed values for security leadership.

## Action catalogue (`vsp/data.json`)

Per action: `class`, `intent`, `killSwitchClass` (`EXEMPT` / `STANDARD` / `WRITE`), `minAssurance`,
`protected`, `roles`, `purposes`, `classifications`, `resourceTypes`, `integrations`,
`requiresActionDigest`, `fieldMask`, `obligations`, `access` paths. Actions:

| Class | Actions |
|---|---|
| SAFETY_AND_HUMAN_ROUTE | `safety:route`, `human:request` |
| PUBLIC_READ (A0, PUBLIC only) | `public:read`, `login_help:read` (never credential reset) |
| INTAKE | `intake:create`, `complaint:create`, `support_request:create` (A0 unlinked; A2 self/representative when linked to a subject), `partner_intake:create` (A2 partner affiliation, organization only) |
| VERIFICATION (A0) | `verification:begin` (generic status only; no account-existence disclosure) |
| PROTECTED_READ (A2) | `appointment:read` (self, representative, treating provider with scope), `appointment:list_options` (same paths, scope `appointment:list_options`; mask adds the opaque `slotId`; plus `provider_own_schedule`: a provider's own open slots, INTERNAL, self fact with scope `appointment:list_options`, `caller_self_service` only), `invoice:read` (self, representative), `claim:read` (self), `onboarding:read` (provider self, practice delegate/member with scope), `remittance:read` (practice delegate/member for exactly that organization), `case:read` (self; organization cases via practice or partner, INTERNAL only) |
| PREPARE / COMMIT_MUTATION (A2, writes switch) | `appointment:prepare_change`, `appointment:commit_change` (digest + `REQUIRE_CONFIRMATION`), `billing:prepare_review` (client self, no digest, `REQUIRE_CONFIRMATION`), `billing:submit_review` (digest + confirmation; never a refund decision) |
| HUMAN_BOUNDARY (always deny, `REQUIRE_HUMAN`) | `account:change_payout_destination`, `account:change_tax_info`, `credentialing:decide`, `clinical_record:read`, `identity:recover`, `credential:reset` |

Resource types accepted per action are listed in the catalogue (e.g. `appointment`,
`appointment_options`, `invoice`, `billing_review`, `claim`, `provider_onboarding`, `remittance`,
`partner_intake`, `support_case`, `support_request`, `knowledge_article`, `verification_challenge`).

### Console catalogue

Separated roles (spec section 7): `support_agent`, `supervisor`, `safety_responder`, `auditor`,
`knowledge_editor`, `policy_approver`, `deployment_operator`, `security_admin`. MFA is required for
every action; requests whose `origin` is not `workforce_console` are denied (the model cannot
request or grant break-glass); holding the `auditor` role makes an identity read-only for every
mutating action; `policy:approve` and `break_glass:approve` can never be self-approved;
`restricted_record:view` needs a valid break-glass grant (time-bound, justified, approved by
someone else) and never adds a role; `db:raw_query`, `secret:view`,
`transcript:download_unrestricted`, `audit:modify`, `audit:delete`, `break_glass:self_grant` are
prohibited for everyone. Kill-switch roles mirror `platform/src/ops/staff-authz.ts`. Every
console decision, allowed or denied, carries `AUDIT_ADMIN_ACTION`. Dedicated read actions
(non-mutating, least privilege, equal to the console endpoint roles): `console:session` (every
staff role), `operations:overview` (support agent, supervisor, safety responder, deployment
operator, security admin), `budget:view` and `kill_switch:view` (supervisor, security admin,
deployment operator), `reconciliation:view` (supervisor), `human_task:view` (support agent,
supervisor), `release:view` (auditor, knowledge editor, policy approver, security admin).

## Golden probes and the "no silent expansion" gate (spec section 14)

* `golden/probes.json` is generated from a declarative matrix: allowed base requests and their
  perturbations (up to 20 each: expiry, revocation, tenant, kill switches, consent, risk flags,
  assurance, role, relationships, verification secret, production), explicit cases and console
  probes (916 in total for bundle `2026.10.18-2`; run `golden-generate.ts` for the counts).
  Expectations are declared intent, written independently of the Rego.
* `platform/src/policy/golden.test.ts` evaluates every probe through the WASM engine and fails on
  any mismatch; a probe whose expectation is deny that now allows (or a wider field mask, or a
  dropped obligation) fails as **SILENT_EXPANSION** unless it is listed in
  `approved-expansions.json` with an approval id that exists in `approvals/` with scope
  `POLICY_RELEASE`. It also checks native `opa eval` and WASM agree on every probe.
* `golden-generate.ts --update` refuses (exit 2, nothing written) to flip deny -> allow, widen a
  mask, drop an obligation, remove a probe or rewrite a deny probe's input without such an entry.
* `golden-gate.test.ts` builds deliberately weakened bundles (consent rule removed, field mask
  widened, PHI path lowered to A1, partner rule removed) and shows each is caught.

## BLOCKED / not done here

| Item | Why | Prerequisite |
|---|---|---|
| Policy release outside local/CI | Needs human approval | `POLICY_RELEASE` approval record (PRQ-031) |
| Consent semantics for declined recording/processing | Jurisdiction-specific legal decision | Privacy counsel (PRQ-026) |
| Minor / representative rules | Legal applicability unknown | Privacy counsel (PRQ-027) |
| Final assurance per action | Identity risk assessment not done | Identity owner (PRQ-030) |
| CI wiring of `--gate` against the main-branch baseline | CI workflow owned by another module | Coordinator |

## OPA notes for maintainers

* `opa fmt` removes parentheses around chained comparisons, which can change meaning
  (`(a == b) == (c in s)` becomes `a == b == c in s`). Bind booleans to variables first.
* A package-level `# entrypoint: true` annotation makes every rule an entrypoint and breaks the
  WASM build; entrypoints are passed with `-e`.
* `with input as p.input` inside a comprehension did not bind as expected in OPA 1.21; bind
  `x := p.input` first (used in the parity test).
