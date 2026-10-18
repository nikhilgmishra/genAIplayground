/**
 * Approvals: open human workflow tasks for the signed-in staff member's roles.
 * Approve or reject requires a reason code. The browser never sees a Step
 * Functions task token: the backend holds it and completes the task after
 * re-validating the staff member's current authority (spec section 9).
 */
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { useApi } from "../api/ApiContext";
import { toConsoleApiError } from "../api/client";
import type { ConsoleApiError } from "../api/client";
import { OPERATOR_REASON_CODES } from "../api/contract";
import type { HumanTaskView } from "../api/contract";
import { useApiQuery } from "../api/useApiQuery";
import { useRoles } from "../auth/AuthProvider";
import { ROLE_LABELS, canDecideTask } from "../auth/roles";
import { useAnnouncer } from "../components/Announcer";
import { Dialog } from "../components/Dialog";
import { ErrorNotice } from "../components/ErrorNotice";
import { QueryView } from "../components/QueryView";
import { EMPTY_REASON, ReasonFields, composeReason } from "../components/ReasonFields";
import type { ReasonValue } from "../components/ReasonFields";
import { ServerEnforcedNote } from "../components/ServerEnforcedNote";
import { Timestamp } from "../components/Timestamp";
import { enumLabel } from "../lib/format";
import { newIdempotencyKey } from "../lib/random";
import { useDocumentTitle } from "../lib/useDocumentTitle";

type Decision = "APPROVE" | "REJECT";

function DecisionDialog({ task, onClose, onDone }: { task: HumanTaskView; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const { announce } = useAnnouncer();
  const [decision, setDecision] = useState<Decision | "">("");
  const [reason, setReason] = useState<ReasonValue>(EMPTY_REASON);
  const [error, setError] = useState<ConsoleApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef(newIdempotencyKey());
  const codes = decision === "" ? [] : OPERATOR_REASON_CODES[`workflows.decision.${decision}`];
  const composed = decision === "" ? null : composeReason(reason, codes);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (decision === "" || !composed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.request("workflows.decision", {
        params: { taskId: task.taskId },
        body: { decision, reason: composed },
        idempotencyKey: keyRef.current,
      });
      announce(`Task ${res.taskId}: ${res.decision} recorded; workflow ${res.workflowId} is ${res.workflowState}. Audit event ${res.auditEventId}.`);
      onDone();
    } catch (err) {
      setError(toConsoleApiError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={`Decide task ${task.taskId}`}
      onClose={onClose}
      description={
        <p>
          {enumLabel(task.workflowType)} — <code>{task.taskType}</code>. Your decision and reason code are audited. The server re-checks your
          current authority for this task before completing it.
        </p>
      }
    >
      <form onSubmit={(e) => void submit(e)}>
        <fieldset className="fieldset">
          <legend>Decision (required)</legend>
          {(["APPROVE", "REJECT"] as const).map((d) => (
            <div className="radio" key={d}>
              <input
                type="radio"
                id={`decision-${d}`}
                name="decision"
                value={d}
                checked={decision === d}
                onChange={() => {
                  setDecision(d);
                  setReason(EMPTY_REASON);
                }}
              />
              <label htmlFor={`decision-${d}`}>{d === "APPROVE" ? "Approve" : "Reject"}</label>
            </div>
          ))}
        </fieldset>
        {decision !== "" ? <ReasonFields codes={codes} value={reason} onChange={setReason} /> : <p className="hint">Choose a decision first; a reason is then required.</p>}
        <ErrorNotice error={error} context="The decision was not recorded." />
        <div className="dialog-actions">
          <button type="submit" disabled={!composed || busy}>
            Submit decision
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            Close without deciding
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ApprovalsPage() {
  useDocumentTitle("Approvals");
  const api = useApi();
  const roles = useRoles();
  const query = useApiQuery(() => api.request("workflows.tasks", {}), []);
  const [deciding, setDeciding] = useState<HumanTaskView | null>(null);
  return (
    <>
      <h1>Approvals</h1>
      <p>
        Open human tasks in durable workflows (billing disputes, document reviews, claim investigations, partner onboarding, complaints,
        callbacks). Accepting a workflow is not resolving the issue.
      </p>
      <ServerEnforcedNote />
      <QueryView query={query} label="workflow tasks">
        {(data) =>
          data.tasks.length === 0 ? (
            <p>No open tasks for your roles.</p>
          ) : (
            <table>
              <caption>Open human tasks ({data.tasks.length})</caption>
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Workflow</th>
                  <th scope="col">Task type</th>
                  <th scope="col">Workflow state</th>
                  <th scope="col">Required roles</th>
                  <th scope="col">Owner queue</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {data.tasks.map((t) => (
                  <tr key={t.taskId}>
                    <th scope="row">
                      <code>{t.taskId}</code>
                    </th>
                    <td>
                      {enumLabel(t.workflowType)} <code>{t.workflowId}</code>
                    </td>
                    <td>
                      <code>{t.taskType}</code>
                    </td>
                    <td>{enumLabel(t.workflowState)}</td>
                    <td>{t.requiredStaffRoles.map((r) => ROLE_LABELS[r]).join(", ")}</td>
                    <td>
                      <code>{t.ownerQueue}</code>
                    </td>
                    <td>
                      <Timestamp value={t.expiresAt} />
                    </td>
                    <td>
                      {canDecideTask(t, roles) ? (
                        <button type="button" onClick={() => setDeciding(t)} aria-label={`Decide task ${t.taskId}`}>
                          Approve or reject
                        </button>
                      ) : (
                        "Not permitted for your roles"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </QueryView>
      {deciding ? (
        <DecisionDialog
          task={deciding}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null);
            query.reload();
          }}
        />
      ) : null}
    </>
  );
}
