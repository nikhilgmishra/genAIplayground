import type { ConsoleApiError } from "../api/client";

/** Errors are shown as reason codes only (no server text, no record contents). */
export function ErrorNotice({ error, context }: { error: Pick<ConsoleApiError, "reasonCode" | "correlationId"> | null; context?: string }) {
  if (!error) return null;
  return (
    <div role="alert" className="notice notice-error">
      <p>
        {context ?? "Request failed."} Reason code: <code>{error.reasonCode}</code>
        {error.correlationId ? (
          <>
            {" "}
            (correlation id <code>{error.correlationId}</code>)
          </>
        ) : null}
      </p>
    </div>
  );
}
