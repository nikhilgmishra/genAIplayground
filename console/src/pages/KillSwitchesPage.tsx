/**
 * Kill switches (spec section 13): separate switches for new AI admissions, an
 * intent, an integration, writes, a model version, a voice version and outbound
 * notifications. Engaging or releasing needs a reason code and a typed
 * confirmation phrase, which the server re-checks. No switch ever gates the
 * approved safety and human routes.
 */
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { useApi } from "../api/ApiContext";
import { toConsoleApiError } from "../api/client";
import type { ConsoleApiError } from "../api/client";
import { GLOBAL_KILL_SWITCH_SCOPES, KILL_SWITCH_SCOPES, OPERATOR_REASON_CODES } from "../api/contract";
import type { KillSwitchConfirmationPhrase, KillSwitchScope, KillSwitchesResponse } from "../api/contract";
import { useApiQuery } from "../api/useApiQuery";
import { useRoles } from "../auth/AuthProvider";
import { canSetKillSwitchScope } from "../auth/roles";
import { useAnnouncer } from "../components/Announcer";
import { Dialog } from "../components/Dialog";
import { ErrorNotice } from "../components/ErrorNotice";
import { QueryView } from "../components/QueryView";
import { EMPTY_REASON, ReasonFields, composeReason } from "../components/ReasonFields";
import type { ReasonValue } from "../components/ReasonFields";
import { ServerEnforcedNote } from "../components/ServerEnforcedNote";
import { StatusText } from "../components/StatusText";
import { Timestamp } from "../components/Timestamp";
import { newIdempotencyKey } from "../lib/random";
import { useDocumentTitle } from "../lib/useDocumentTitle";

export const SCOPE_LABEL: Readonly<Record<KillSwitchScope, string>> = {
  AI_ADMISSION: "New AI admissions",
  INTENT: "An intent",
  INTEGRATION: "An integration",
  WRITES: "All writes (consequential commits)",
  MODEL_VERSION: "A model version",
  VOICE_VERSION: "A voice version",
  OUTBOUND_NOTIFICATIONS: "Outbound notifications",
};

const isGlobal = (scope: KillSwitchScope): boolean => (GLOBAL_KILL_SWITCH_SCOPES as readonly KillSwitchScope[]).includes(scope);

export function confirmationPhrase(scope: KillSwitchScope, target: string, engaged: boolean): KillSwitchConfirmationPhrase {
  return `${engaged ? "ENGAGE" : "RELEASE"} ${scope} ${target}`;
}

function targetsFor(data: KillSwitchesResponse, scope: KillSwitchScope): string[] {
  if (isGlobal(scope)) return ["*"];
  if (scope === "INTENT" || scope === "INTEGRATION" || scope === "MODEL_VERSION" || scope === "VOICE_VERSION") return data.targets[scope];
  return [];
}

export interface KillSwitchPreset {
  scope: KillSwitchScope;
  target: string;
  engaged: boolean;
}

function KillSwitchDialog({
  data,
  preset,
  onClose,
  onDone,
}: {
  data: KillSwitchesResponse;
  preset: KillSwitchPreset | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApi();
  const roles = useRoles();
  const { announce } = useAnnouncer();
  const [scope, setScope] = useState<KillSwitchScope | "">(preset?.scope ?? "");
  const [target, setTarget] = useState<string>(preset?.target ?? "");
  const [engaged, setEngaged] = useState<boolean | null>(preset ? preset.engaged : null);
  const [reason, setReason] = useState<ReasonValue>(EMPTY_REASON);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<ConsoleApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef(newIdempotencyKey());

  const targets = scope === "" ? [] : targetsFor(data, scope);
  const effectiveTarget = scope !== "" && isGlobal(scope) ? "*" : target;
  const codes = engaged === null ? [] : OPERATOR_REASON_CODES[engaged ? "killSwitches.set.engage" : "killSwitches.set.release"];
  const composed = engaged === null ? null : composeReason(reason, codes);
  const phrase = scope !== "" && engaged !== null && effectiveTarget ? confirmationPhrase(scope, effectiveTarget, engaged) : null;
  const permitted = scope !== "" && canSetKillSwitchScope(scope, roles);
  const valid = permitted && targets.includes(effectiveTarget) && composed !== null && phrase !== null && typed === phrase;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || engaged === null || composed === null || phrase === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.request("killSwitches.set", {
        body: { scope, target: effectiveTarget, engaged, reason: composed, confirmationPhrase: phrase },
        idempotencyKey: keyRef.current,
      });
      announce(
        `Kill switch ${res.switch.scope} (${res.switch.target}) ${res.switch.engaged ? "engaged" : "released"}. Safety and human routes remain available. Audit event ${res.auditEventId}.`,
      );
      onDone();
    } catch (err) {
      setError(toConsoleApiError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Change a kill switch"
      onClose={onClose}
      description={
        <p>
          Choose the narrowest switch that contains the problem. The change is audited; if the audit event cannot be written the change is
          refused. Safety and human routes stay available whatever you choose.
        </p>
      }
    >
      <form onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor="ks-scope">Scope</label>
          <select
            id="ks-scope"
            required
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as KillSwitchScope | "");
              setTarget("");
              setTyped("");
            }}
          >
            <option value="">Choose a scope</option>
            {KILL_SWITCH_SCOPES.map((s) => {
              const allowed = canSetKillSwitchScope(s, roles);
              return (
                <option key={s} value={s} disabled={!allowed}>
                  {s} — {SCOPE_LABEL[s]}
                  {allowed ? "" : " (not permitted for your roles)"}
                </option>
              );
            })}
          </select>
        </div>
        {scope !== "" ? (
          isGlobal(scope) ? (
            <p className="field">
              Target: <code>*</code> (this scope applies globally)
            </p>
          ) : (
            <div className="field">
              <label htmlFor="ks-target">Target (from trusted configuration)</label>
              <select
                id="ks-target"
                required
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setTyped("");
                }}
              >
                <option value="">Choose a target</option>
                {targets.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          )
        ) : null}
        <fieldset className="fieldset">
          <legend>Change (required)</legend>
          {([true, false] as const).map((v) => (
            <div className="radio" key={String(v)}>
              <input
                type="radio"
                id={`ks-engaged-${String(v)}`}
                name="ks-engaged"
                checked={engaged === v}
                onChange={() => {
                  setEngaged(v);
                  setReason(EMPTY_REASON);
                  setTyped("");
                }}
              />
              <label htmlFor={`ks-engaged-${String(v)}`}>{v ? "Engage (stop this automation)" : "Release (resume this automation)"}</label>
            </div>
          ))}
        </fieldset>
        {engaged !== null ? <ReasonFields codes={codes} value={reason} onChange={setReason} /> : null}
        {phrase ? (
          <div className="field">
            <label htmlFor="ks-confirm">
              Type <code>{phrase}</code> to confirm
            </label>
            <input
              id="ks-confirm"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              aria-invalid={typed.length > 0 && typed !== phrase}
              aria-describedby="ks-confirm-hint"
              onChange={(e) => setTyped(e.target.value)}
            />
            <p id="ks-confirm-hint" className="hint">
              {typed === phrase ? "Confirmation phrase matches." : "The confirmation phrase must match exactly."}
            </p>
          </div>
        ) : null}
        {scope !== "" && !permitted ? (
          <p className="field-error" role="alert">
            Your roles do not permit changing this scope.
          </p>
        ) : null}
        <ErrorNotice error={error} context="The kill switch was not changed." />
        <div className="dialog-actions">
          <button type="submit" disabled={!valid || busy}>
            Apply kill switch change
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            Close without changes
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function KillSwitchesPage() {
  useDocumentTitle("Kill switches");
  const api = useApi();
  const roles = useRoles();
  const query = useApiQuery(() => api.request("killSwitches.list", {}), []);
  const [dialog, setDialog] = useState<{ preset: KillSwitchPreset | null } | null>(null);
  const canChangeAny = KILL_SWITCH_SCOPES.some((s) => canSetKillSwitchScope(s, roles));

  return (
    <>
      <h1>Kill switches</h1>
      <p className="notice notice-safe" data-testid="safety-routes-banner">
        <strong>Safety and human routes remain available</strong> whatever switches are engaged. Engaging a switch never disconnects an active
        safety handoff, and callers who ask for a person are still routed to staffed queues.
      </p>
      <ServerEnforcedNote />
      <QueryView query={query} label="kill switches">
        {(data) => (
          <>
            {canChangeAny ? (
              <button type="button" onClick={() => setDialog({ preset: null })}>
                Change a kill switch
              </button>
            ) : null}
            <table>
              <caption>Kill switch state ({data.switches.filter((s) => s.engaged).length} engaged)</caption>
              <thead>
                <tr>
                  <th scope="col">Scope</th>
                  <th scope="col">Target</th>
                  <th scope="col">State</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Changed by</th>
                  <th scope="col">Changed</th>
                  <th scope="col">Operator action</th>
                </tr>
              </thead>
              <tbody>
                {data.switches.map((s) => (
                  <tr key={s.switchId}>
                    <th scope="row">
                      {s.scope} <span className="hint">({SCOPE_LABEL[s.scope]})</span>
                    </th>
                    <td>
                      <code>{s.target}</code>
                    </td>
                    <td>{s.engaged ? <StatusText tone="bad" label="Engaged" /> : <StatusText tone="ok" label="Released" />}</td>
                    <td>
                      <code>{s.reason}</code>
                    </td>
                    <td>
                      <code>{s.changedBy}</code>
                    </td>
                    <td>
                      <Timestamp value={s.changedAt} />
                    </td>
                    <td>
                      {canSetKillSwitchScope(s.scope, roles) ? (
                        <button
                          type="button"
                          onClick={() => setDialog({ preset: { scope: s.scope, target: s.target, engaged: !s.engaged } })}
                          aria-label={`${s.engaged ? "Release" : "Engage"} ${s.scope} ${s.target}`}
                        >
                          {s.engaged ? "Release" : "Engage"}
                        </button>
                      ) : (
                        "Not permitted for your roles"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {dialog ? (
              <KillSwitchDialog
                data={data}
                preset={dialog.preset}
                onClose={() => setDialog(null)}
                onDone={() => {
                  setDialog(null);
                  query.reload();
                }}
              />
            ) : null}
          </>
        )}
      </QueryView>
    </>
  );
}
