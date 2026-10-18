/**
 * Safety events: content-free evidence of safety signals and priority routing
 * (rule ids and signal sources, never the caller's words). The 2 s figure is an
 * engineering target for initiating the route, not a staffed-connection
 * commitment (spec section 10).
 */
import { Link } from "react-router-dom";
import { useApi } from "../api/ApiContext";
import type { SafetyRouteOutcome } from "../api/contract";
import { consoleRoutes, isOpaqueId } from "../api/paths";
import { useApiQuery } from "../api/useApiQuery";
import { useRoles } from "../auth/AuthProvider";
import { canUse } from "../auth/roles";
import { QueryView } from "../components/QueryView";
import { StatusText } from "../components/StatusText";
import type { Tone } from "../components/StatusText";
import { Timestamp } from "../components/Timestamp";
import { enumLabel, yesNo } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const OUTCOME_TONE: Readonly<Record<SafetyRouteOutcome, Tone>> = {
  IN_PROGRESS: "warn",
  TRANSFERRED: "ok",
  CALLER_DISCONNECTED: "bad",
  FAILED: "bad",
  OUTCOME_UNKNOWN: "bad",
};

export function SafetyEventsPage() {
  useDocumentTitle("Safety events");
  const api = useApi();
  const roles = useRoles();
  const query = useApiQuery(() => api.request("safetyEvents.list", {}), []);
  const canInspectCall = canUse("calls.get", roles);
  return (
    <>
      <h1>Safety events</h1>
      <p>
        Safety signals and priority human routing. Records are content-free: signal sources and rule ids only. Authentication is never
        required for the safety route, and no kill switch or budget limit gates it.
      </p>
      <QueryView query={query} label="safety events">
        {(data) =>
          data.events.length === 0 ? (
            <p>No safety events.</p>
          ) : (
            <table>
              <caption>Safety events ({data.events.length})</caption>
              <thead>
                <tr>
                  <th scope="col">Incident</th>
                  <th scope="col">Call</th>
                  <th scope="col">Detected</th>
                  <th scope="col">Route</th>
                  <th scope="col">Signal sources</th>
                  <th scope="col">Strength</th>
                  <th scope="col">Destination</th>
                  <th scope="col">Time to route</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Audit</th>
                  <th scope="col">After hours</th>
                  <th scope="col">Locale</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.incidentId}>
                    <th scope="row">
                      <code>{e.incidentId}</code>
                    </th>
                    <td>
                      {canInspectCall && isOpaqueId(e.callId) ? (
                        <Link to={consoleRoutes.call(e.callId)}>
                          <code>{e.callId}</code>
                        </Link>
                      ) : (
                        <code>{e.callId}</code>
                      )}
                    </td>
                    <td>
                      <Timestamp value={e.detectedAt} />
                    </td>
                    <td>{enumLabel(e.route)}</td>
                    <td>
                      {e.signalSources.map((s) => enumLabel(s)).join(", ")}
                      {e.ruleIds.length > 0 ? (
                        <>
                          {" "}
                          (rules{" "}
                          {e.ruleIds.map((r) => (
                            <code key={r}>{r} </code>
                          ))}
                          )
                        </>
                      ) : null}
                    </td>
                    <td>{e.strongestStrength ? enumLabel(e.strongestStrength) : "—"}</td>
                    <td>
                      <code>{e.destinationId}</code>
                    </td>
                    <td>
                      {e.latencyMs === null ? (
                        <StatusText tone="warn" label="Route initiation not recorded" />
                      ) : (
                        <StatusText
                          tone={e.withinTarget ? "ok" : "bad"}
                          label={`${e.latencyMs} ms (${e.withinTarget ? "within" : "over"} ${e.targetMs} ms target)`}
                        />
                      )}
                    </td>
                    <td>
                      <StatusText tone={OUTCOME_TONE[e.outcome]} label={enumLabel(e.outcome)} />
                    </td>
                    <td>
                      {e.auditStatus === "RECORDED" ? (
                        <StatusText tone="ok" label="Recorded" />
                      ) : (
                        <StatusText tone="bad" label="Audit unavailable" />
                      )}
                    </td>
                    <td>{yesNo(e.afterHours)}</td>
                    <td>
                      {e.locale}
                      {e.localeSupported ? "" : " (not supported by safety signal detection)"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </QueryView>
    </>
  );
}
