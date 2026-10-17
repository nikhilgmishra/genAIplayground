/**
 * Metadata-only audit search (spec section 13). Filters are opaque ids, an
 * action name and a UTC time range; there is no free-text search, no content
 * and no evidence-object download. Every search is itself audited. Filters are
 * kept in component state, never in the URL.
 */
import { useId, useState } from "react";
import type { FormEvent } from "react";
import { useApi } from "../api/ApiContext";
import { toConsoleApiError } from "../api/client";
import type { ConsoleApiError } from "../api/client";
import { AUDIT_ACTION_PATTERN, MAX_AUDIT_SEARCH_LIMIT } from "../api/contract";
import type { AuditSearchQuery, AuditSearchResponse } from "../api/contract";
import { isOpaqueId } from "../api/paths";
import { ErrorNotice } from "../components/ErrorNotice";
import { StatusText } from "../components/StatusText";
import { Timestamp } from "../components/Timestamp";
import { enumLabel } from "../lib/format";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const ACTION_RE = new RegExp(AUDIT_ACTION_PATTERN);
const LOCAL_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

interface Filters {
  correlationId: string;
  callId: string;
  action: string;
  from: string;
  to: string;
  limit: string;
}

type FieldErrors = Partial<Record<keyof Filters, string>>;

/** datetime-local value interpreted as UTC. */
function toUtcIso(value: string): string | null {
  if (!LOCAL_DT_RE.test(value)) return null;
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  const iso = `${withSeconds}.000Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

export function validateFilters(f: Filters): { query: AuditSearchQuery | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const query: AuditSearchQuery = { limit: 50 };
  const corr = f.correlationId.trim();
  const call = f.callId.trim();
  const action = f.action.trim();
  if (corr) {
    if (isOpaqueId(corr)) query.correlationId = corr;
    else errors.correlationId = "Must be an opaque id (for example cor_…).";
  }
  if (call) {
    if (isOpaqueId(call)) query.callId = call;
    else errors.callId = "Must be an opaque call id (for example cal_…), never a phone number.";
  }
  if (action) {
    if (ACTION_RE.test(action) && !/\d{4,}/.test(action)) query.action = action;
    else errors.action = "Must be a dotted action name such as killswitch.set.";
  }
  if (f.from) {
    const v = toUtcIso(f.from);
    if (v) query.from = v;
    else errors.from = "Invalid date and time.";
  }
  if (f.to) {
    const v = toUtcIso(f.to);
    if (v) query.to = v;
    else errors.to = "Invalid date and time.";
  }
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) errors.to = "Must not be before the start.";
  const limit = Number(f.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_SEARCH_LIMIT) errors.limit = `Must be a whole number from 1 to ${MAX_AUDIT_SEARCH_LIMIT}.`;
  else query.limit = limit;
  return { query: Object.keys(errors).length === 0 ? query : null, errors };
}

function Field({
  name,
  label,
  type = "text",
  value,
  error,
  onChange,
  hint,
}: {
  name: keyof Filters;
  label: string;
  type?: string;
  value: string;
  error: string | undefined;
  onChange: (v: string) => void;
  hint?: string;
}) {
  const id = useId();
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
        {...(type === "number" ? { min: 1, max: MAX_AUDIT_SEARCH_LIMIT, step: 1 } : {})}
      />
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function AuditSearchPage() {
  useDocumentTitle("Audit search");
  const api = useApi();
  const [filters, setFilters] = useState<Filters>({ correlationId: "", callId: "", action: "", from: "", to: "", limit: "50" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<AuditSearchResponse | null>(null);
  const [error, setError] = useState<ConsoleApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Filters) => (v: string) => setFilters((prev) => ({ ...prev, [k]: v }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const { query, errors: errs } = validateFilters(filters);
    setErrors(errs);
    if (!query) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.request("audit.search", { query }));
    } catch (err) {
      setError(toConsoleApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Audit search</h1>
      <p>
        Metadata only: no content, transcripts, recordings or evidence objects are available here, and audit evidence cannot be changed from
        this console. Every search is itself recorded as an audit event.
      </p>
      <form onSubmit={(e) => void submit(e)} className="filters" aria-label="Audit search filters" noValidate>
        <Field name="correlationId" label="Correlation id" value={filters.correlationId} error={errors.correlationId} onChange={set("correlationId")} />
        <Field name="callId" label="Call id" value={filters.callId} error={errors.callId} onChange={set("callId")} />
        <Field name="action" label="Action" value={filters.action} error={errors.action} onChange={set("action")} hint="For example killswitch.set or action.commit." />
        <Field name="from" label="From (UTC)" type="datetime-local" value={filters.from} error={errors.from} onChange={set("from")} />
        <Field name="to" label="To (UTC)" type="datetime-local" value={filters.to} error={errors.to} onChange={set("to")} />
        <Field name="limit" label="Maximum results" type="number" value={filters.limit} error={errors.limit} onChange={set("limit")} />
        <button type="submit" disabled={busy}>
          Search audit metadata
        </button>
      </form>
      <ErrorNotice error={error} context="Audit search failed." />
      {result ? (
        <section aria-labelledby="audit-results">
          <h2 id="audit-results">Results</h2>
          <p>
            {result.events.length} events (limit {result.limit}). This search was recorded as audit event <code>{result.searchAuditEventId}</code>.
          </p>
          {result.events.length > 0 ? (
            <table>
              <caption>Audit event metadata</caption>
              <thead>
                <tr>
                  <th scope="col">Occurred</th>
                  <th scope="col">Event</th>
                  <th scope="col">Action</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Reason code</th>
                  <th scope="col">Source</th>
                  <th scope="col">Role</th>
                  <th scope="col">Call</th>
                  <th scope="col">Correlation</th>
                  <th scope="col">Policy decision</th>
                  <th scope="col">Data class</th>
                  <th scope="col">Stream / sequence</th>
                </tr>
              </thead>
              <tbody>
                {result.events.map((e) => (
                  <tr key={e.eventId}>
                    <td>
                      <Timestamp value={e.occurredAt} />
                    </td>
                    <th scope="row">
                      <code>{e.eventId}</code>
                    </th>
                    <td>
                      <code>{e.action}</code>
                    </td>
                    <td>
                      <StatusText tone={e.outcome === "DENIED" || e.outcome === "FAILED" || e.outcome === "UNKNOWN" ? "warn" : "neutral"} label={enumLabel(e.outcome)} />
                    </td>
                    <td>{e.reasonCode ? <code>{e.reasonCode}</code> : "—"}</td>
                    <td>{e.sourceComponent}</td>
                    <td>{e.role ?? "—"}</td>
                    <td>{e.callId ? <code>{e.callId}</code> : "—"}</td>
                    <td>
                      <code>{e.correlationId}</code>
                    </td>
                    <td>
                      {e.policyDecision ? (
                        <>
                          {e.policyDecision.allow ? "Allow" : "Deny"} <code>{e.policyDecision.policyVersion}</code>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{e.dataClass}</td>
                    <td>
                      <code>{e.sourceStream}</code> #{e.sequence}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
