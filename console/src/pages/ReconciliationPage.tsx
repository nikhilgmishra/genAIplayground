/**
 * Reconciliation queue (ACT-03): actions whose commit outcome is UNKNOWN (or a
 * stale COMMITTING) must be reconciled against the system of record by
 * idempotency key before anything is retried. Retry is offered ONLY after the
 * latest reconciliation returned NOT_FOUND; the server re-checks this.
 * Dead-lettered outbox messages can be requeued; consumers deduplicate (ACT-02).
 */
import { useState } from "react";
import { useApi } from "../api/ApiContext";
import { toConsoleApiError } from "../api/client";
import type { ConsoleApiError } from "../api/client";
import { OPERATOR_REASON_CODES } from "../api/contract";
import type { DeadLetterItem, ReconcileResultView, ReconciliationItem } from "../api/contract";
import { useApiQuery } from "../api/useApiQuery";
import { useRoles } from "../auth/AuthProvider";
import { canUse } from "../auth/roles";
import { useAnnouncer } from "../components/Announcer";
import { ErrorNotice } from "../components/ErrorNotice";
import { QueryView } from "../components/QueryView";
import { ReasonActionDialog } from "../components/ReasonActionDialog";
import { ServerEnforcedNote } from "../components/ServerEnforcedNote";
import { StatusText } from "../components/StatusText";
import type { Tone } from "../components/StatusText";
import { Timestamp } from "../components/Timestamp";
import { enumLabel } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const RESULT_TONE: Readonly<Record<ReconcileResultView["result"], Tone>> = { COMMITTED: "ok", NOT_FOUND: "warn", UNKNOWN: "bad" };

interface LocalResult {
  result: ReconcileResultView;
  retryEligible: boolean;
}

/** Retry is allowed only when the latest reconciliation says the provider has no record of the commit. */
export function retryAllowed(item: ReconciliationItem, local: LocalResult | undefined): boolean {
  const latest = local?.result ?? item.lastReconcile;
  const eligible = local ? local.retryEligible : item.retryEligible;
  return latest !== null && latest.result === "NOT_FOUND" && eligible;
}

export function ReconciliationPage() {
  useDocumentTitle("Reconciliation queue");
  const api = useApi();
  const roles = useRoles();
  const { announce } = useAnnouncer();
  const query = useApiQuery(() => api.request("reconciliation.list", {}), []);
  const [local, setLocal] = useState<Record<string, LocalResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ConsoleApiError | null>(null);
  const [retrying, setRetrying] = useState<{ item: ReconciliationItem; reconciliationId: string } | null>(null);
  const [requeueing, setRequeueing] = useState<DeadLetterItem | null>(null);

  const canReconcile = canUse("reconciliation.reconcile", roles);
  const canRetry = canUse("reconciliation.retry", roles);
  const canRequeue = canUse("outbox.requeue", roles);

  const reconcile = async (item: ReconciliationItem) => {
    setBusy(item.actionId);
    setError(null);
    try {
      const res = await api.request("reconciliation.reconcile", { params: { actionId: item.actionId }, body: {} });
      setLocal((prev) => ({ ...prev, [item.actionId]: { result: res.result, retryEligible: res.retryEligible } }));
      announce(
        `Reconciliation for ${res.actionId}: provider result ${res.result.result}; action state ${res.state}. ${
          res.result.result === "NOT_FOUND" && res.retryEligible ? "Retry is now available." : "Retry is not available."
        } Audit event ${res.auditEventId}.`,
      );
    } catch (err) {
      setError(toConsoleApiError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h1>Reconciliation queue</h1>
      <p>
        Unknown outcomes are reconciled with the system of record before any retry or success is announced. A timeout is never treated as
        proof that nothing happened.
      </p>
      <ServerEnforcedNote />
      <ErrorNotice error={error} context="Reconciliation request failed." />
      <QueryView query={query} label="reconciliation queue">
        {(data) => (
          <>
            <section aria-labelledby="rec-actions">
              <h2 id="rec-actions">Actions needing reconciliation</h2>
              {data.actions.length === 0 ? (
                <p>No actions need reconciliation.</p>
              ) : (
                <table>
                  <caption>Actions with UNKNOWN or stale COMMITTING outcome ({data.actions.length})</caption>
                  <thead>
                    <tr>
                      <th scope="col">Action</th>
                      <th scope="col">Kind</th>
                      <th scope="col">State</th>
                      <th scope="col">Provider system</th>
                      <th scope="col">Since</th>
                      <th scope="col">Attempts</th>
                      <th scope="col">Latest reconciliation</th>
                      <th scope="col">Operator actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.actions.map((item) => {
                      const latest = local[item.actionId]?.result ?? item.lastReconcile;
                      const allowed = retryAllowed(item, local[item.actionId]);
                      const hintId = `retry-hint-${item.actionId}`;
                      return (
                        <tr key={item.actionId}>
                          <th scope="row">
                            <code>{item.actionId}</code>
                          </th>
                          <td>
                            <code>{item.kind}</code>
                          </td>
                          <td>{enumLabel(item.state)}</td>
                          <td>{item.providerSystem}</td>
                          <td>
                            <Timestamp value={item.since} />
                          </td>
                          <td>{item.attempts}</td>
                          <td>
                            {latest ? (
                              <>
                                <StatusText tone={RESULT_TONE[latest.result]} label={enumLabel(latest.result)} /> at <Timestamp value={latest.at} />
                              </>
                            ) : (
                              "Not yet reconciled"
                            )}
                          </td>
                          <td className="actions-cell">
                            {canReconcile ? (
                              <button
                                type="button"
                                onClick={() => void reconcile(item)}
                                disabled={busy === item.actionId}
                                aria-label={`Reconcile action ${item.actionId}`}
                              >
                                Reconcile
                              </button>
                            ) : null}
                            {canRetry ? (
                              <>
                                <button
                                  type="button"
                                  disabled={!allowed}
                                  aria-describedby={hintId}
                                  aria-label={`Retry action ${item.actionId}`}
                                  onClick={() => latest && setRetrying({ item, reconciliationId: latest.reconciliationId })}
                                >
                                  Retry
                                </button>
                                <span id={hintId} className="hint">
                                  {allowed
                                    ? "Reconciliation returned NOT_FOUND: retry is allowed."
                                    : "Retry is available only after reconciliation returns NOT_FOUND."}
                                </span>
                              </>
                            ) : null}
                            {!canReconcile && !canRetry ? "Not permitted for your roles" : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>

            <section aria-labelledby="rec-dlq">
              <h2 id="rec-dlq">Dead-letter messages</h2>
              {data.deadLetters.length === 0 ? (
                <p>No dead-lettered messages.</p>
              ) : (
                <table>
                  <caption>Dead-lettered outbox messages ({data.deadLetters.length}); payloads are never shown</caption>
                  <thead>
                    <tr>
                      <th scope="col">Message</th>
                      <th scope="col">Topic</th>
                      <th scope="col">Aggregate</th>
                      <th scope="col">Attempts</th>
                      <th scope="col">Last reason</th>
                      <th scope="col">Dead since</th>
                      <th scope="col">Operator action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.deadLetters.map((m) => (
                      <tr key={m.messageId}>
                        <th scope="row">
                          <code>{m.messageId}</code>
                        </th>
                        <td>
                          <code>{m.topic}</code>
                        </td>
                        <td>
                          <code>{m.aggregateRef}</code>
                        </td>
                        <td>{m.attempts}</td>
                        <td>{m.lastReasonCode ? <code>{m.lastReasonCode}</code> : "—"}</td>
                        <td>
                          <Timestamp value={m.deadAt} />
                        </td>
                        <td>
                          {canRequeue ? (
                            <button type="button" onClick={() => setRequeueing(m)} aria-label={`Requeue message ${m.messageId}`}>
                              Requeue
                            </button>
                          ) : (
                            "Not permitted for your roles"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </QueryView>

      {retrying ? (
        <ReasonActionDialog
          title={`Retry action ${retrying.item.actionId}`}
          description={
            <p>
              Reconciliation <code>{retrying.reconciliationId}</code> found no record of this commit at the provider (NOT_FOUND). The retry
              reuses the action's provider idempotency key; whether the provider deduplicates depends on that system's documented commit
              semantics. The server refuses a stale or non-NOT_FOUND reconciliation.
            </p>
          }
          codes={OPERATOR_REASON_CODES["reconciliation.retry"]}
          submitLabel="Confirm retry"
          onClose={() => setRetrying(null)}
          onSubmit={async (reason, idempotencyKey) => {
            const res = await api.request("reconciliation.retry", {
              params: { actionId: retrying.item.actionId },
              body: { reconciliationId: retrying.reconciliationId, reason },
              idempotencyKey,
            });
            return `Retry of ${res.actionId}: outcome ${res.outcome}, state ${res.state}. Audit event ${res.auditEventId}.`;
          }}
          onDone={() => {
            setRetrying(null);
            setLocal({});
            query.reload();
          }}
        />
      ) : null}

      {requeueing ? (
        <ReasonActionDialog
          title={`Requeue message ${requeueing.messageId}`}
          description={
            <p>
              Returns the dead-lettered <code>{requeueing.topic}</code> message to the outbox. Consumers deduplicate by message id, so a requeue
              cannot create a duplicate effect. Fix the root cause first.
            </p>
          }
          codes={OPERATOR_REASON_CODES["outbox.requeue"]}
          submitLabel="Confirm requeue"
          onClose={() => setRequeueing(null)}
          onSubmit={async (reason, idempotencyKey) => {
            const res = await api.request("outbox.requeue", { params: { messageId: requeueing.messageId }, body: { reason }, idempotencyKey });
            return `Message ${res.messageId} ${res.requeued ? "requeued" : "was not requeued"}. Audit event ${res.auditEventId}.`;
          }}
          onDone={() => {
            setRequeueing(null);
            query.reload();
          }}
        />
      ) : null}
    </>
  );
}
