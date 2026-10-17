import { Link } from "react-router-dom";
import { useApi } from "../api/ApiContext";
import { consoleRoutes, isOpaqueId } from "../api/paths";
import { useApiQuery } from "../api/useApiQuery";
import { useRoles } from "../auth/AuthProvider";
import { canUse } from "../auth/roles";
import { QueryView } from "../components/QueryView";
import { StatusText } from "../components/StatusText";
import { Timestamp } from "../components/Timestamp";
import { enumLabel } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";

export function ActiveCallsPage() {
  useDocumentTitle("Active calls");
  const api = useApi();
  const roles = useRoles();
  const query = useApiQuery(() => api.request("calls.list", { query: { state: "active" } }), []);
  const canInspect = canUse("calls.get", roles);
  return (
    <>
      <h1>Active calls</h1>
      <p>
        Active support journeys identified by opaque call ids only. No caller names, phone numbers or transcript content are shown in this
        console.
      </p>
      <button type="button" className="button-secondary" onClick={query.reload}>
        Refresh calls
      </button>
      <QueryView query={query} label="active calls">
        {(data) =>
          data.calls.length === 0 ? (
            <p>No active calls.</p>
          ) : (
            <table>
              <caption>Active calls ({data.calls.length})</caption>
              <thead>
                <tr>
                  <th scope="col">Call</th>
                  <th scope="col">State</th>
                  <th scope="col">Assurance</th>
                  <th scope="col">Intent category</th>
                  <th scope="col">Safety</th>
                  <th scope="col">Started</th>
                  <th scope="col">Transfer</th>
                  <th scope="col">Language</th>
                </tr>
              </thead>
              <tbody>
                {data.calls.map((c) => (
                  <tr key={c.callId}>
                    <th scope="row">
                      {canInspect && isOpaqueId(c.callId) ? (
                        <Link to={consoleRoutes.call(c.callId)} aria-label={`Investigate call ${c.callId}`}>
                          <code>{c.callId}</code>
                        </Link>
                      ) : (
                        <code>{c.callId}</code>
                      )}
                      {c.localFixture ? <span className="badge badge-fixture badge-small">SYNTHETIC</span> : null}
                    </th>
                    <td>{enumLabel(c.state)}</td>
                    <td>{c.assurance}</td>
                    <td>{c.intentCategory ? enumLabel(c.intentCategory) : "Not yet known"}</td>
                    <td>{c.safetyFlag ? <StatusText tone="bad" label="Safety route active" /> : <StatusText tone="neutral" label="None" />}</td>
                    <td>
                      <Timestamp value={c.startedAt} />
                    </td>
                    <td>{c.transferState ? enumLabel(c.transferState) : "None"}</td>
                    <td>{c.language}</td>
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
