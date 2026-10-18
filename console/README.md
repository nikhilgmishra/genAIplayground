# console: operations and incident control console

Status: **IMPLEMENTED_OFFLINE**. React 19 + TypeScript + Vite single-page app, built and tested
against the typed contract in `platform/src/console-api/contract.ts` using a labelled mock backend
(`src/test/mock-api.ts`). The backend console API is not implemented yet, so `pnpm dev` has no
real server to talk to until it is. Workforce SSO is BLOCKED (PRQ-036). Not verified against any
vendor, real IdP or production; this is not a claim of HIPAA compliance or production readiness.

## Commands

```sh
cd console
npx tsc -p tsconfig.json --noEmit   # typecheck (also: pnpm --filter @vsp/console typecheck)
npx vitest run                      # unit, RBAC, flow and axe-core accessibility tests
npx vite build                      # production bundle in console/dist (gitignored)
npx eslint src                      # lint, including the browser-storage and raw-HTML bans
npx vite                            # dev server on 127.0.0.1:5173; proxies /console/api -> 127.0.0.1:8080
```

## Sections

Overview (live sessions, queue health, AI admission, dependency health, audit backlog, planned
dashboards) · Active calls · Call investigation (content-free timeline, allowlisted transfer) ·
Support request trace · Pending actions (cancel uncommitted work) · Reconciliation queue
(reconcile, retry only after NOT_FOUND, dead-letter requeue) · Approvals (workflow tasks with a
mandatory reason) · Safety events · Releases review (a review is not an approval) · Budgets
(alerts are not hard caps) · Kill switches (reason code + typed confirmation; safety and human
routes remain available) · Audit search (metadata only) · Destinations (read-only allowlist) ·
Escalation and playbooks (roster BLOCKED on PRQ-001 and PRQ-011).

Navigation and actions follow `ENDPOINT_ROLES` and the per-scope, per-task and per-release role
tables. That is presentation only: the server enforces every rule on every request.

## Security rules built into the console

* The bearer token is held in memory only (`src/api/token.ts`); `localStorage`,
  `sessionStorage`, IndexedDB and `document.cookie` are lint-banned. The one exception is
  `src/auth/pkce.ts`, which keeps the PKCE verifier, state and nonce in `sessionStorage` for one
  redirect round-trip and deletes them on use. Reloading the page signs the operator out.
* Requests use `credentials: "omit"`; mutations carry an `Idempotency-Key` per confirmed dialog.
* Routes and API paths carry opaque ids only; invalid references are refused without being
  echoed or requested. Audit filters live in component state, never in the URL.
* No transcript, audio, recording, raw query, secret or task-token view exists; pages render
  an explicit allowlist of fields, so unexpected fields from a server are never shown.
* Operator reasons are allowlisted reason codes plus an optional opaque incident id; there is no
  free-text reason field.
* Errors are shown as reason codes and correlation ids only.
* The local sign-in picker ("LOCAL DEV SIGN-IN (synthetic staff)") appears only when the backend
  reports local fixture mode in a local or CI environment, and a persistent
  "LOCAL FIXTURE — SYNTHETIC DATA" badge is shown whenever `localFixture` is true.

## Known gaps

* Colour contrast is not checked automatically: jsdom cannot paint, so the axe `color-contrast`
  rule is disabled in tests. A real-browser accessibility check and a manual screen-reader pass
  are still to do.
* No join-call action (Talkdesk control unverified, TB-07); no safety-event acknowledgement;
  no policy source-text viewer.
* Test data is synthetic (`src/test/fixtures.ts`, built from `platform/src/fixtures/synthetic-world.ts`).
