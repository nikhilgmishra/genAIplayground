/**
 * Pending actions: review prepared/confirmed actions and cancel uncommitted
 * work. Once a commit has started the action can no longer be cancelled; it
 * goes to reconciliation instead (ACT-03).
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../api/ApiContext";
import { OPERATOR_REASON_CODES } from "../api/contract";
import type { PendingActionView } from "../api/contract";
import { consoleRoutes, isOpaqueId } from "../api/paths";
import { useApiQuery } from "../api/useApiQuery";
import { useRoles } from "../auth/AuthProvider";
import { canUse } from "../auth/roles";
import { QueryView } from "../components/QueryView";
import { ReasonActionDialog } from "../components/ReasonActionDialog";
import { ServerEnforcedNote } from "../components/ServerEnforcedNote";
import { Timestamp } from "../components/Timestamp";
import { enumLabel, yesNo } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";

export function PendingActionsPage() {
  useDocumentTitle("Pending actions");
  const api = useApi();
  const roles = useRoles();
  const query = useApiQuery(() => api.request("actions.pending", {}), []);
  const [cancelling, setCancelling] = useState<PendingActionView | null>(null);
  const canCancel = canUse("actions.cancel", roles);
  const canInspectCall = canUse("calls.get", roles);

  return (
    <>
      <h1>Pending actions</h1>
      <p>
        Prepared and confirmed actions awaiting commit. Only uncommitted work can be cancelled; an action whose commit has started is handled
        in the reconciliation queue.
      </p>
      <ServerEnforcedNote />
      <QueryView query={query} label="pending actions">
        {(data) =>
          data.actions.length === 0 ? (
            <p>No pending actions.</p>
          ) : (
            <table>
              <caption>Pending actions ({data.actions.length})</caption>
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Kind</th>
                  <th scope="col">State</th>
                  <th scope="col">Call</th>
                  <th scope="col">Prepared</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Step-up required</th>
                  <th scope="col">Target</th>
                  <th scope="col">Digest prefix</th>
                  <th scope="col">Operator action</th>
                </tr>
              </thead>
              <tbody>
                {data.actions.map((a) => (
                  <tr key={a.actionId}>
                    <th scope="row">
                      <code>{a.actionId}</code>
                    </th>
                    <td>
                      <code>{a.kind}</code>
                    </td>
                    <td>{enumLabel(a.state)}</td>
                    <td>
                      {a.callId && canInspectCall && isOpaqueId(a.callId) ? (
                        <Link to={consoleRoutes.call(a.callId)}>
                          <code>{a.callId}</code>
                        </Link>
                      ) : a.callId ? (
                        <code>{a.callId}</code>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <Timestamp value={a.preparedAt} />
                    </td>
                    <td>
                      <Timestamp value={a.expiresAt} />
                    </td>
                    <td>{yesNo(a.requiresStepUp)}</td>
                    <td>
                      {a.target.system} / {a.target.recordType}
                    </td>
                    <td>
                      <code>{a.digestPrefix}</code>
                    </td>
                    <td>
                      {!canCancel ? (
                        "Not permitted for your roles"
                      ) : a.cancellable && a.state !== "COMMITTING" ? (
                        <button type="button" onClick={() => setCancelling(a)} aria-label={`Cancel action ${a.actionId}`}>
                          Cancel action
                        </button>
                      ) : (
                        <>
                          Not cancellable{a.notCancellableReason ? <> (<code>{a.notCancellableReason}</code>)</> : null}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </QueryView>
      {cancelling ? (
        <ReasonActionDialog
          title={`Cancel action ${cancelling.actionId}`}
          description={
            <p>
              Cancels the uncommitted <code>{cancelling.kind}</code> action. The cancellation is audited. If the commit has already started
              the server refuses it with <code>ACTION_NOT_CANCELLABLE</code> and the action is handled by reconciliation.
            </p>
          }
          codes={OPERATOR_REASON_CODES["actions.cancel"]}
          submitLabel="Confirm cancellation"
          onClose={() => setCancelling(null)}
          onSubmit={async (reason, idempotencyKey) => {
            const expectedState = cancelling.state === "CONFIRMED" ? "CONFIRMED" : "PREPARED";
            const res = await api.request("actions.cancel", {
              params: { actionId: cancelling.actionId },
              body: { reason, expectedState },
              idempotencyKey,
            });
            return `Action ${res.actionId} is ${res.state}. Audit event ${res.auditEventId}.`;
          }}
          onDone={() => {
            setCancelling(null);
            query.reload();
          }}
        />
      ) : null}
    </>
  );
}
