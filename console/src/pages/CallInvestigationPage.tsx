/**
 * Call investigation: a content-free timeline of one support journey (tool
 * invocations with status and reason codes, policy decisions, actions and
 * receipts, transfers, safety events, support request references). There is no
 * transcript, audio or recording view anywhere in the console (spec section 16).
 */
import { useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi } from "../api/ApiContext";
import { toConsoleApiError } from "../api/client";
import type { ConsoleApiError } from "../api/client";
import { OPERATOR_REASON_CODES } from "../api/contract";
import type { CallDetailResponse, CallTimelineEvent, DestinationView, TransferReason, VersionSetView } from "../api/contract";
import { consoleRoutes, isOpaqueId, isSupportReference } from "../api/paths";
import { useApiQuery } from "../api/useApiQuery";
import { useRoles } from "../auth/AuthProvider";
import { canUse } from "../auth/roles";
import { useAnnouncer } from "../components/Announcer";
import { Dialog } from "../components/Dialog";
import { ErrorNotice } from "../components/ErrorNotice";
import { QueryView } from "../components/QueryView";
import { ServerEnforcedNote } from "../components/ServerEnforcedNote";
import { StatusText } from "../components/StatusText";
import type { Tone } from "../components/StatusText";
import { Timestamp } from "../components/Timestamp";
import { enumLabel, yesNo } from "../lib/format";
import { newIdempotencyKey } from "../lib/random";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const TOOL_TONE: Readonly<Record<string, Tone>> = {
  SUCCESS: "ok",
  PENDING: "neutral",
  RETRYABLE_FAILURE: "warn",
  PERMANENT_FAILURE: "bad",
  POLICY_DENIED: "warn",
  UNKNOWN_OUTCOME: "bad",
};

/** Explicit allowlist: only known fields are ever rendered, whatever the server sends. */
const VERSION_KEYS: readonly (readonly [keyof VersionSetView, string])[] = [
  ["agentConfig", "Agent configuration"],
  ["model", "Model"],
  ["voice", "Voice"],
  ["promptTemplates", "Prompt templates"],
  ["policyBundle", "Policy bundle"],
  ["toolCatalog", "Tool catalogue digest"],
  ["knowledgeSnapshot", "Knowledge snapshot"],
  ["schema", "Schema"],
];

const KNOWN_KINDS: ReadonlySet<string> = new Set<CallTimelineEvent["kind"]>([
  "session",
  "tool_invocation",
  "policy_decision",
  "action",
  "transfer",
  "safety_event",
  "support_request",
]);

/** Keeps only event kinds this console knows how to render from content-free fields. */
export function knownTimeline(events: readonly CallTimelineEvent[]): { shown: CallTimelineEvent[]; withheld: number } {
  const shown = events.filter((e) => typeof e === "object" && e !== null && KNOWN_KINDS.has((e as { kind?: unknown }).kind as string));
  return { shown, withheld: events.length - shown.length };
}

interface Row {
  label: string;
  detail: ReactNode;
  status: ReactNode;
}

function describe(event: CallTimelineEvent): Row {
  switch (event.kind) {
    case "session":
      return { label: "Session", detail: <>{enumLabel(event.change)}</>, status: <>Assurance {event.assurance}</> };
    case "tool_invocation":
      return {
        label: "Tool invocation",
        detail: (
          <>
            <code>
              {event.tool.name}@{event.tool.version}
            </code>
            {event.policyDecisionId ? (
              <>
                {" "}
                decision <code>{event.policyDecisionId}</code>
              </>
            ) : null}
            {event.latencyMs !== null ? <> · {event.latencyMs} ms</> : null}
          </>
        ),
        status: (
          <>
            <StatusText tone={TOOL_TONE[event.status] ?? "neutral"} label={enumLabel(event.status)} />
            {event.reasonCode ? (
              <>
                {" "}
                <code>{event.reasonCode}</code>
              </>
            ) : null}
          </>
        ),
      };
    case "policy_decision":
      return {
        label: "Policy decision",
        detail: (
          <>
            <code>{event.policyAction}</code> decision <code>{event.decisionId}</code> · policy <code>{event.policyVersion}</code>
            {event.obligations.length > 0 ? <> · obligations {event.obligations.join(", ")}</> : null}
          </>
        ),
        status: (
          <>
            <StatusText tone={event.allow ? "ok" : "warn"} label={event.allow ? "Allowed" : "Denied"} />{" "}
            {event.reasonCodes.map((r) => (
              <code key={r}>{r} </code>
            ))}
          </>
        ),
      };
    case "action":
      return {
        label: "Action",
        detail: (
          <>
            <code>{event.actionKind}</code> <code>{event.actionId}</code>
            {event.receiptId ? (
              <>
                {" "}
                receipt <code>{event.receiptId}</code>
              </>
            ) : null}
          </>
        ),
        status: (
          <>
            {enumLabel(event.state)}
            {event.commitOutcome ? <> · commit outcome {event.commitOutcome}</> : null}
          </>
        ),
      };
    case "transfer":
      return {
        label: "Transfer",
        detail: (
          <>
            <code>{event.transferId}</code> to <code>{event.destinationId}</code> · {enumLabel(event.reason)} · package acknowledged{" "}
            {yesNo(event.receiverAcknowledgedPackage)}
          </>
        ),
        status: <>{enumLabel(event.transferState)}</>,
      };
    case "safety_event":
      return {
        label: "Safety event",
        detail: (
          <>
            <code>{event.incidentId}</code> · {enumLabel(event.phase)} · {enumLabel(event.route)}
          </>
        ),
        status:
          event.latencyMs !== null ? (
            <StatusText tone={event.withinTarget ? "ok" : "bad"} label={`Route initiated in ${event.latencyMs} ms${event.withinTarget ? " (within target)" : " (over target)"}`} />
          ) : (
            <>—</>
          ),
      };
    case "support_request":
      return {
        label: "Support request",
        detail: <code>{event.referenceNumber}</code>,
        status: <>Sync {enumLabel(event.syncState)}</>,
      };
  }
}

function TransferDialog({ callId, open, onClose, onDone }: { callId: string; open: boolean; onClose: () => void; onDone: () => void }) {
  const api = useApi();
  const { announce } = useAnnouncer();
  const destinations = useApiQuery(open ? () => api.request("destinations.list", {}) : null, [open]);
  const [destinationId, setDestinationId] = useState("");
  const [reason, setReason] = useState<TransferReason | "">("");
  const [error, setError] = useState<ConsoleApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef(newIdempotencyKey());

  const allowlist: DestinationView[] = destinations.data?.destinations ?? [];
  const valid = allowlist.some((d) => d.destinationId === destinationId) && reason !== "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.request("calls.transfer", {
        params: { callId },
        body: { destinationId, reason },
        idempotencyKey: keyRef.current,
      });
      announce(
        `Transfer ${res.transferId} requested to ${res.destinationId}: state ${res.state}. It is not complete until the receiver accepts and the caller is confirmed connected. Audit event ${res.auditEventId}.`,
      );
      onDone();
    } catch (err) {
      setError(toConsoleApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Transfer this call"
      onClose={onClose}
      description={
        <p>
          Choose a destination from the trusted allowlist. Arbitrary numbers cannot be dialled. A transfer counts as complete only after the
          receiver accepts and the caller is confirmed connected.
        </p>
      }
    >
      <form onSubmit={(e) => void submit(e)}>
        <ErrorNotice error={destinations.error} context="Could not load destinations." />
        <div className="field">
          <label htmlFor="transfer-destination">Destination (allowlist)</label>
          <select id="transfer-destination" required value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
            <option value="">Choose a destination</option>
            {allowlist.map((d) => (
              <option key={d.destinationId} value={d.destinationId}>
                {d.destinationId} — {enumLabel(d.purpose)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="transfer-reason">Transfer reason</label>
          <select id="transfer-reason" required value={reason} onChange={(e) => setReason(e.target.value as TransferReason | "")}>
            <option value="">Choose a reason</option>
            {OPERATOR_REASON_CODES["calls.transfer"].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <ErrorNotice error={error} context="Transfer was not requested." />
        <div className="dialog-actions">
          <button type="submit" disabled={!valid || busy}>
            Request transfer
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CallBody({ data, reload }: { data: CallDetailResponse; reload: () => void }) {
  const roles = useRoles();
  const [transferOpen, setTransferOpen] = useState(false);
  const canTransfer = canUse("calls.transfer", roles) && data.controls.transfer.available;
  const call = data.call;
  const timeline = knownTimeline(data.timeline);
  return (
    <>
      <p className="notice">
        Transcripts, audio and recording links are never available in this console. The timeline shows content-free events only.
      </p>
      <section aria-labelledby="call-summary">
        <h2 id="call-summary">Summary</h2>
        <dl className="summary-grid">
          <div>
            <dt>Call</dt>
            <dd>
              <code>{call.callId}</code>
              {call.localFixture ? <span className="badge badge-fixture badge-small">SYNTHETIC</span> : null}
            </dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{enumLabel(call.state)}</dd>
          </div>
          <div>
            <dt>Assurance tier</dt>
            <dd>{call.assurance}</dd>
          </div>
          <div>
            <dt>Session generation</dt>
            <dd>{call.sessionGeneration}</dd>
          </div>
          <div>
            <dt>Intent category</dt>
            <dd>{call.intentCategory ? enumLabel(call.intentCategory) : "Not yet known"}</dd>
          </div>
          <div>
            <dt>Safety</dt>
            <dd>{call.safetyFlag ? <StatusText tone="bad" label="Safety route active" /> : <StatusText tone="neutral" label="None" />}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>
              <Timestamp value={call.startedAt} />
            </dd>
          </div>
          <div>
            <dt>Transfer state</dt>
            <dd>{call.transferState ? enumLabel(call.transferState) : "None"}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="call-controls">
        <h2 id="call-controls">Supported controls</h2>
        <ServerEnforcedNote />
        <ul className="plain-list">
          <li>
            Transfer:{" "}
            {data.controls.transfer.available ? (
              canTransfer ? (
                <button type="button" onClick={() => setTransferOpen(true)}>
                  Transfer call
                </button>
              ) : (
                "available, but not permitted for your roles"
              )
            ) : (
              <>
                unavailable{data.controls.transfer.reasonCode ? <> (<code>{data.controls.transfer.reasonCode}</code>)</> : null}
              </>
            )}
          </li>
          <li>
            Join: {data.controls.join.available ? "supported by the telephony integration; use the Talkdesk agent workspace" : "unavailable"}
            {data.controls.join.reasonCode ? (
              <>
                {" "}
                (<code>{data.controls.join.reasonCode}</code>)
              </>
            ) : null}
            . This console version has no join action because the supported Talkdesk control is unverified (TB-07).
          </li>
        </ul>
      </section>

      {data.versions ? (
        <section aria-labelledby="call-versions">
          <h2 id="call-versions">Pinned versions</h2>
          <dl className="summary-grid">
            {VERSION_KEYS.map(([k, label]) => (
              <div key={k}>
                <dt>{label}</dt>
                <dd>
                  <code>{data.versions?.[k]}</code>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section aria-labelledby="call-timeline">
        <h2 id="call-timeline">Timeline</h2>
        {timeline.withheld > 0 ? (
          <p className="notice notice-warn">
            {timeline.withheld} event(s) of an unrecognized kind were not displayed. The console renders only known content-free fields.
          </p>
        ) : null}
        <table>
          <caption>Content-free event timeline ({timeline.shown.length} events)</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Event</th>
              <th scope="col">Detail</th>
              <th scope="col">Status</th>
              <th scope="col">Audit event</th>
            </tr>
          </thead>
          <tbody>
            {timeline.shown.map((ev) => {
              const row = describe(ev);
              return (
                <tr key={ev.eventId}>
                  <td>
                    <Timestamp value={ev.at} />
                  </td>
                  <th scope="row">{row.label}</th>
                  <td>{row.detail}</td>
                  <td>{row.status}</td>
                  <td>{ev.auditEventId ? <code>{ev.auditEventId}</code> : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="call-srs">
        <h2 id="call-srs">Support requests</h2>
        {data.supportRequestRefs.length === 0 ? (
          <p>No support request linked to this call.</p>
        ) : (
          <ul className="plain-list">
            {data.supportRequestRefs.map((ref) =>
              isSupportReference(ref) && canUse("supportRequests.trace", roles) ? (
                <li key={ref}>
                  <Link to={consoleRoutes.supportRequest(ref)}>Trace {ref}</Link>
                </li>
              ) : (
                <li key={ref}>
                  <code>{ref}</code>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      {transferOpen ? (
        <TransferDialog
          callId={call.callId}
          open={transferOpen}
          onClose={() => setTransferOpen(false)}
          onDone={() => {
            setTransferOpen(false);
            reload();
          }}
        />
      ) : null}
    </>
  );
}

export function CallInvestigationPage() {
  useDocumentTitle("Call investigation");
  const api = useApi();
  const { callId = "" } = useParams();
  const valid = isOpaqueId(callId);
  const query = useApiQuery(valid ? () => api.request("calls.get", { params: { callId } }) : null, [callId]);
  return (
    <>
      <h1>Call investigation</h1>
      <p>
        <Link to="/calls">Back to active calls</Link>
      </p>
      {!valid ? (
        <div role="alert" className="notice notice-error">
          <p>
            This address does not contain a valid opaque call reference, so nothing was requested. Use the active calls list; never put phone
            numbers or names in the address bar.
          </p>
        </div>
      ) : (
        <QueryView query={query} label="call">
          {(data) => <CallBody data={data} reload={query.reload} />}
        </QueryView>
      )}
    </>
  );
}
