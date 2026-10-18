/**
 * Operator reason input. Reasons are allowlisted reason codes plus an optional
 * opaque incident reference (contract OPERATOR_REASON_PATTERN), never free
 * text, so no personal details can be typed into an administrative record.
 */
import { useId } from "react";
import { isOpaqueId, isOperatorReason } from "../api/paths";

export interface ReasonValue {
  code: string;
  incidentRef: string;
}

export const EMPTY_REASON: ReasonValue = { code: "", incidentRef: "" };

/** Returns the composed reason (`CODE` or `CODE:<incident id>`) or null when incomplete/invalid. */
export function composeReason(value: ReasonValue, allowed: readonly string[]): string | null {
  if (!allowed.includes(value.code)) return null;
  const ref = value.incidentRef.trim();
  if (ref && !isOpaqueId(ref)) return null;
  const reason = ref ? `${value.code}:${ref}` : value.code;
  return isOperatorReason(reason) ? reason : null;
}

export interface ReasonFieldsProps {
  codes: readonly string[];
  value: ReasonValue;
  onChange: (value: ReasonValue) => void;
  legend?: string;
}

export function ReasonFields({ codes, value, onChange, legend = "Reason" }: ReasonFieldsProps) {
  const id = useId();
  const codeId = `${id}-code`;
  const refId = `${id}-ref`;
  const hintId = `${id}-hint`;
  const refErrorId = `${id}-ref-error`;
  const ref = value.incidentRef.trim();
  const refInvalid = ref.length > 0 && !isOpaqueId(ref);
  return (
    <fieldset className="fieldset">
      <legend>{legend} (required)</legend>
      <p id={hintId} className="hint">
        Choose a reason code. Free text is not accepted, so names, dates of birth, phone numbers and other personal details can never be
        entered here.
      </p>
      <div className="field">
        <label htmlFor={codeId}>Reason code</label>
        <select
          id={codeId}
          required
          aria-required="true"
          aria-describedby={hintId}
          value={value.code}
          onChange={(e) => onChange({ ...value, code: e.target.value })}
        >
          <option value="">Choose a reason code</option>
          {codes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={refId}>Incident reference (optional opaque id, for example inc_…)</label>
        <input
          id={refId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
          value={value.incidentRef}
          aria-invalid={refInvalid}
          aria-describedby={refInvalid ? refErrorId : undefined}
          onChange={(e) => onChange({ ...value, incidentRef: e.target.value })}
        />
        {refInvalid ? (
          <p id={refErrorId} className="field-error">
            Not an opaque reference. Use the incident id from the incident record, never personal details.
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}
