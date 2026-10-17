/**
 * Support request trace: support request -> sync state -> Salesforce Case id
 * -> actions -> workflows -> audit event ids. Metadata only; the minimized
 * summary and any caller content are not shown.
 */
import { useId, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApi } from "../api/ApiContext";
import type { SupportTraceResponse } from "../api/contract";
import { consoleRoutes, isOpaqueId, isSupportReference } from "../api/paths";
import { useApiQuery } from "../api/useApiQuery";
import { useRoles } from "../auth/AuthProvider";
import { canUse } from "../auth/roles";
import { QueryView } from "../components/QueryView";
import { StatusText } from "../components/StatusText";
import { Timestamp } from "../components/Timestamp";
import { enumLabel, yesNo } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";

function LookupForm() {
  const navigate = useNavigate();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const ref = value.trim().toUpperCase();
    if (!isSupportReference(ref)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    navigate(consoleRoutes.supportRequest(ref));
  };
  return (
    <form onSubmit={submit} className="inline-form">
      <div className="field">
        <label htmlFor={inputId}>Support reference</label>
        <input
          id={inputId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={14}
          value={value}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
          onChange={(e) => setValue(e.target.value)}
        />
        <p id={hintId} className="hint">
          Format SR-XXXX-XXXX. Only the opaque reference is accepted; never enter names, dates of birth or phone numbers.
        </p>
        {invalid ? (
          <p id={errorId} className="field-error" role="alert">
            Not a valid support reference. Nothing was looked up.
          </p>
        ) : null}
      </div>
      <button type="submit">Trace</button>
    </form>
  );
}

function TraceBody({ data }: { data: SupportTraceResponse }) {
  const roles = useRoles();
  const sr = data.supportRequest;
  const canInspectCall = canUse("calls.get", roles);
  return (
    <>
      <p className="notice">
        A Case created or a workflow accepted is not issue resolution: disposition comes only from recorded outcome evidence.
      </p>
      <section aria-labelledby="trace-sr">
        <h2 id="trace-sr">Support request</h2>
        <dl className="summary-grid">
          <div>
            <dt>Reference</dt>
            <dd>
              <code>{sr.referenceNumber}</code> (<code>{sr.supportRequestId}</code>)
            </dd>
          </div>
          <div>
            <dt>Issue category</dt>
            <dd>{enumLabel(sr.issueCategory)}</dd>
          </div>
          <div>
            <dt>Disposition</dt>
            <dd>{enumLabel(sr.disposition)}</dd>
          </div>
          <div>
            <dt>Owner queue</dt>
            <dd>
              <code>{sr.ownerQueue}</code>
            </dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>{enumLabel(sr.priority)}</dd>
          </div>
          <div>
            <dt>Restricted record</dt>
            <dd>{yesNo(sr.restricted)}</dd>
          </div>
          <div>
            <dt>Created / updated</dt>
            <dd>
              <Timestamp value={sr.createdAt} /> / <Timestamp value={sr.updatedAt} />
            </dd>
          </div>
          <div>
            <dt>Source calls</dt>
            <dd>
              {sr.sourceCallIds.map((id) =>
                canInspectCall && isOpaqueId(id) ? (
                  <Link key={id} to={consoleRoutes.call(id)} className="inline-ref">
                    <code>{id}</code>
                  </Link>
                ) : (
                  <code key={id} className="inline-ref">
                    {id}
                  </code>
                ),
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="trace-sync">
        <h2 id="trace-sync">Synchronization to Salesforce</h2>
        <dl className="summary-grid">
          <div>
            <dt>Sync state</dt>
            <dd>
              <StatusText
                tone={data.sync.state === "SYNCED" ? "ok" : data.sync.state === "DEAD_LETTER" ? "bad" : "warn"}
                label={enumLabel(data.sync.state)}
              />
            </dd>
          </div>
          <div>
            <dt>Salesforce Case id</dt>
            <dd>
              {data.sync.salesforceCaseId ? (
                <code>{data.sync.salesforceCaseId}</code>
              ) : (
                "None yet: the support reference is pending synchronization (no Case number is ever invented)."
              )}
            </dd>
          </div>
          <div>
            <dt>Attempts</dt>
            <dd>
              {data.sync.attempts}
              {data.sync.lastReasonCode ? (
                <>
                  {" "}
                  (last <code>{data.sync.lastReasonCode}</code>)
                </>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Last attempt / synced</dt>
            <dd>
              <Timestamp value={data.sync.lastAttemptAt} /> / <Timestamp value={data.sync.syncedAt} />
            </dd>
          </div>
          <div>
            <dt>Outbox messages</dt>
            <dd>{data.sync.outboxMessageIds.length === 0 ? "None" : data.sync.outboxMessageIds.map((m) => <code key={m} className="inline-ref">{m}</code>)}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="trace-actions">
        <h2 id="trace-actions">Actions</h2>
        {data.actions.length === 0 ? (
          <p>No actions.</p>
        ) : (
          <table>
            <caption>Actions and commit receipts</caption>
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Kind</th>
                <th scope="col">State</th>
                <th scope="col">Commit outcome</th>
                <th scope="col">Receipt</th>
                <th scope="col">Committed</th>
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
                  <td>{a.commitOutcome ?? "—"}</td>
                  <td>{a.receiptId ? <code>{a.receiptId}</code> : "—"}</td>
                  <td>
                    <Timestamp value={a.committedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="trace-workflows">
        <h2 id="trace-workflows">Workflows</h2>
        {data.workflows.length === 0 ? (
          <p>No workflows.</p>
        ) : (
          <table>
            <caption>Durable workflows</caption>
            <thead>
              <tr>
                <th scope="col">Workflow</th>
                <th scope="col">Type</th>
                <th scope="col">State</th>
                <th scope="col">Definition</th>
                <th scope="col">Owner queue</th>
                <th scope="col">Deadline</th>
                <th scope="col">Open tasks</th>
              </tr>
            </thead>
            <tbody>
              {data.workflows.map((w) => (
                <tr key={w.workflowId}>
                  <th scope="row">
                    <code>{w.workflowId}</code>
                  </th>
                  <td>{enumLabel(w.type)}</td>
                  <td>{enumLabel(w.state)}</td>
                  <td>
                    <code>{w.definitionVersion}</code>
                  </td>
                  <td>
                    <code>{w.ownerQueue}</code>
                  </td>
                  <td>
                    <Timestamp value={w.deadline} />
                  </td>
                  <td>{w.openTaskIds.length === 0 ? "None" : w.openTaskIds.map((t) => <code key={t} className="inline-ref">{t}</code>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="trace-audit">
        <h2 id="trace-audit">Audit events</h2>
        <p>
          {data.auditEventIds.length} audit event ids. Auditors and security administrators can search them by correlation id in audit search.
        </p>
        <ul className="plain-list id-list">
          {data.auditEventIds.map((id) => (
            <li key={id}>
              <code>{id}</code>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export function SupportTracePage() {
  useDocumentTitle("Support request trace");
  const api = useApi();
  const { ref = "" } = useParams();
  const hasRef = ref.length > 0;
  const valid = isSupportReference(ref);
  const query = useApiQuery(valid ? () => api.request("supportRequests.trace", { params: { ref } }) : null, [ref]);
  return (
    <>
      <h1>Support request trace</h1>
      <p>Trace a support request end to end: synchronization, Salesforce Case id, actions, workflows and audit evidence.</p>
      <LookupForm />
      {hasRef && !valid ? (
        <div role="alert" className="notice notice-error">
          <p>This address does not contain a valid support reference, so nothing was requested.</p>
        </div>
      ) : null}
      {valid ? (
        <QueryView query={query} label="support request trace">
          {(data) => <TraceBody data={data} />}
        </QueryView>
      ) : null}
    </>
  );
}
