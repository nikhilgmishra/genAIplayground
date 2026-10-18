import { Link } from "react-router-dom";
import { useApi } from "../api/ApiContext";
import type { OverviewResponse } from "../api/contract";
import { useApiQuery } from "../api/useApiQuery";
import { useRoles } from "../auth/AuthProvider";
import { canUse } from "../auth/roles";
import { QueryView } from "../components/QueryView";
import { StatusText, healthTone } from "../components/StatusText";
import type { Tone } from "../components/StatusText";
import { Timestamp } from "../components/Timestamp";
import { DASHBOARDS } from "../content/playbooks";
import { enumLabel, formatCount, formatSeconds, yesNo } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const ADMISSION_TONE: Readonly<Record<OverviewResponse["aiAdmission"]["state"], Tone>> = {
  OPEN: "ok",
  CLOSED_BY_KILL_SWITCH: "bad",
  LIMITED_BY_BUDGET: "warn",
  LIMITED_BY_CAPACITY: "warn",
  UNKNOWN: "neutral",
};

function OverviewBody({ data }: { data: OverviewResponse }) {
  const roles = useRoles();
  return (
    <>
      <p className="hint">
        Generated <Timestamp value={data.generatedAt} />.
      </p>
      <section aria-labelledby="ov-summary">
        <h2 id="ov-summary">Summary</h2>
        <dl className="summary-grid">
          <div>
            <dt>Live sessions</dt>
            <dd>
              {data.liveSessions.active} active, {data.liveSessions.inTransfer} in transfer, {data.liveSessions.safetyActive} on a safety route
            </dd>
          </div>
          <div>
            <dt>New AI admissions</dt>
            <dd>
              <StatusText tone={ADMISSION_TONE[data.aiAdmission.state]} label={enumLabel(data.aiAdmission.state)} />
              {data.aiAdmission.reasonCode ? (
                <>
                  {" "}
                  (<code>{data.aiAdmission.reasonCode}</code>)
                </>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Kill switches engaged</dt>
            <dd>
              {canUse("killSwitches.list", roles) ? <Link to="/kill-switches">{data.killSwitchesEngaged}</Link> : data.killSwitchesEngaged}
            </dd>
          </div>
          <div>
            <dt>Reconciliation backlog</dt>
            <dd>
              {canUse("reconciliation.list", roles) ? <Link to="/reconciliation">{data.reconciliationBacklog}</Link> : data.reconciliationBacklog}
            </dd>
          </div>
          <div>
            <dt>Open safety events</dt>
            <dd>{canUse("safetyEvents.list", roles) ? <Link to="/safety-events">{data.openSafetyEvents}</Link> : data.openSafetyEvents}</dd>
          </div>
          <div>
            <dt>Audit evidence</dt>
            <dd>
              <StatusText
                tone={data.audit.canAcceptConsequential ? "ok" : "bad"}
                label={data.audit.canAcceptConsequential ? "Accepting consequential actions" : "Consequential actions blocked (fail closed)"}
              />
              . Backlog {data.audit.backlogCount}, oldest unshipped {formatSeconds(data.audit.oldestUnshippedAgeSeconds)}, sink{" "}
              {data.audit.sinkHealthy ? "healthy" : "unhealthy"}
              {data.audit.reasonCode ? (
                <>
                  {" "}
                  (<code>{data.audit.reasonCode}</code>)
                </>
              ) : null}
              .
            </dd>
          </div>
        </dl>
        <p className="notice">
          The independent Talkdesk Studio route to human support does not depend on this console, the gateway, the policy service or a model
          response. Kill switches and budget limits never gate safety and human routes.
        </p>
      </section>

      <section aria-labelledby="ov-queues">
        <h2 id="ov-queues">Queue health</h2>
        <table>
          <caption>Queue health by owner queue</caption>
          <thead>
            <tr>
              <th scope="col">Queue</th>
              <th scope="col">Status</th>
              <th scope="col">Waiting</th>
              <th scope="col">Oldest wait</th>
              <th scope="col">Available agents</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {data.queues.map((q) => (
              <tr key={q.queueId}>
                <th scope="row">
                  {q.label} <code>{q.queueId}</code>
                </th>
                <td>
                  <StatusText tone={healthTone(q.status)} label={enumLabel(q.status)} />
                  {q.reasonCode ? (
                    <>
                      {" "}
                      <code>{q.reasonCode}</code>
                    </>
                  ) : null}
                </td>
                <td>{formatCount(q.waiting)}</td>
                <td>{formatSeconds(q.oldestWaitSeconds)}</td>
                <td>{formatCount(q.availableAgents)}</td>
                <td>{q.source === "local_fixture" ? "LOCAL FIXTURE" : "Live"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="ov-deps">
        <h2 id="ov-deps">Dependency health</h2>
        <table>
          <caption>Dependency health and circuit state</caption>
          <thead>
            <tr>
              <th scope="col">Dependency</th>
              <th scope="col">Status</th>
              <th scope="col">Circuit</th>
              <th scope="col">Adapter</th>
              <th scope="col">Reason code</th>
              <th scope="col">Checked</th>
            </tr>
          </thead>
          <tbody>
            {data.dependencies.map((d) => (
              <tr key={d.dependencyId}>
                <th scope="row">
                  <code>{d.dependencyId}</code>
                </th>
                <td>
                  <StatusText tone={healthTone(d.status)} label={enumLabel(d.status)} />
                </td>
                <td>{enumLabel(d.circuit)}</td>
                <td>{d.kind === "local_fixture" ? "LOCAL FIXTURE" : "Live"}</td>
                <td>{d.reasonCode ? <code>{d.reasonCode}</code> : "—"}</td>
                <td>
                  <Timestamp value={d.checkedAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="ov-dashboards">
        <h2 id="ov-dashboards">Operational dashboards</h2>
        <p>
          Dashboards are defined as Terraform plans (<code>infra/terraform/modules/observability</code>) and are not deployed; the metrics export
          and paging are BLOCKED (PRQ-011, PRQ-047). Links are not shown because no dashboard exists in any account yet.
        </p>
        <table>
          <caption>Planned dashboards</caption>
          <thead>
            <tr>
              <th scope="col">Dashboard</th>
              <th scope="col">Covers</th>
              <th scope="col">Deployed</th>
            </tr>
          </thead>
          <tbody>
            {DASHBOARDS.map((d) => (
              <tr key={d.name}>
                <th scope="row">
                  <code>{d.name}</code>
                </th>
                <td>{d.covers}</td>
                <td>{yesNo(false)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

export function OverviewPage() {
  useDocumentTitle("Overview");
  const api = useApi();
  const query = useApiQuery(() => api.request("overview", {}), []);
  return (
    <>
      <h1>Overview</h1>
      <p>Live sessions, queue health, AI admission state, dependency health and audit backlog.</p>
      <button type="button" className="button-secondary" onClick={query.reload}>
        Refresh overview
      </button>
      <QueryView query={query} label="overview">
        {(data) => <OverviewBody data={data} />}
      </QueryView>
    </>
  );
}
