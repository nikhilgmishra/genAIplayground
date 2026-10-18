import { useApi } from "../api/ApiContext";
import { useApiQuery } from "../api/useApiQuery";
import { QueryView } from "../components/QueryView";
import { StatusText } from "../components/StatusText";
import { enumLabel } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";

/** Read-only transfer destination allowlist from trusted configuration (SAFE-05). */
export function DestinationsPage() {
  useDocumentTitle("Destinations");
  const api = useApi();
  const query = useApiQuery(() => api.request("destinations.list", {}), []);
  return (
    <>
      <h1>Transfer destinations</h1>
      <p>
        Transfers can target only these allowlisted destinations. The list comes from trusted configuration and cannot be edited in the console;
        a caller, a model or a retrieved document can never choose a dial target.
      </p>
      <QueryView query={query} label="destinations">
        {(data) => (
          <table>
            <caption>Destination allowlist ({data.destinations.length}, read-only)</caption>
            <thead>
              <tr>
                <th scope="col">Destination</th>
                <th scope="col">Purpose</th>
                <th scope="col">Fallbacks</th>
                <th scope="col">Languages</th>
                <th scope="col">Vendor queue</th>
              </tr>
            </thead>
            <tbody>
              {data.destinations.map((d) => (
                <tr key={d.destinationId}>
                  <th scope="row">
                    <code>{d.destinationId}</code>
                  </th>
                  <td>{enumLabel(d.purpose)}</td>
                  <td>{d.fallbackDestinationIds.length === 0 ? "None" : d.fallbackDestinationIds.map((f) => <code key={f} className="inline-ref">{f}</code>)}</td>
                  <td>{d.languages.join(", ")}</td>
                  <td>
                    {d.vendorQueueConfigured ? (
                      <StatusText tone="ok" label="Configured" />
                    ) : (
                      <StatusText tone="warn" label="Placeholder pending Talkdesk export" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryView>
    </>
  );
}
