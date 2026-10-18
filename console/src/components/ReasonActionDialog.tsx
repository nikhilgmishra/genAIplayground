/**
 * Confirmation dialog for a single audited operator action that needs a reason
 * code (cancel, retry after reconciliation, dead-letter requeue). One
 * idempotency key per opened dialog, so a double submit cannot apply twice.
 */
import { useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { toConsoleApiError } from "../api/client";
import type { ConsoleApiError } from "../api/client";
import { newIdempotencyKey } from "../lib/random";
import { useAnnouncer } from "./Announcer";
import { Dialog } from "./Dialog";
import { ErrorNotice } from "./ErrorNotice";
import { EMPTY_REASON, ReasonFields, composeReason } from "./ReasonFields";
import type { ReasonValue } from "./ReasonFields";

export interface ReasonActionDialogProps {
  title: string;
  description: ReactNode;
  codes: readonly string[];
  submitLabel: string;
  onClose: () => void;
  /** Performs the request; returns the result message for the live region. */
  onSubmit: (reason: string, idempotencyKey: string) => Promise<string>;
  onDone: () => void;
}

export function ReasonActionDialog({ title, description, codes, submitLabel, onClose, onSubmit, onDone }: ReasonActionDialogProps) {
  const { announce } = useAnnouncer();
  const [reason, setReason] = useState<ReasonValue>(EMPTY_REASON);
  const [error, setError] = useState<ConsoleApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef(newIdempotencyKey());
  const composed = composeReason(reason, codes);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!composed) return;
    setBusy(true);
    setError(null);
    try {
      announce(await onSubmit(composed, keyRef.current));
      onDone();
    } catch (err) {
      setError(toConsoleApiError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open title={title} description={description} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <ReasonFields codes={codes} value={reason} onChange={setReason} />
        <ErrorNotice error={error} context="The action was not applied." />
        <div className="dialog-actions">
          <button type="submit" disabled={!composed || busy}>
            {submitLabel}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            Close without changes
          </button>
        </div>
      </form>
    </Dialog>
  );
}
