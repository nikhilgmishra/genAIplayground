/**
 * Live region for action results (WCAG 4.1.3 status messages). Results are also
 * visible on screen; the region is announced politely by assistive technology.
 */
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

interface AnnouncerApi {
  message: string;
  announce: (message: string) => void;
  clear: () => void;
}

const AnnouncerContext = createContext<AnnouncerApi | null>(null);

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const announce = useCallback((next: string) => setMessage(next), []);
  const clear = useCallback(() => setMessage(""), []);
  const value = useMemo(() => ({ message, announce, clear }), [message, announce, clear]);
  return <AnnouncerContext.Provider value={value}>{children}</AnnouncerContext.Provider>;
}

export function useAnnouncer(): AnnouncerApi {
  const ctx = useContext(AnnouncerContext);
  if (!ctx) throw new Error("AnnouncerProvider missing");
  return ctx;
}

/** Rendered once inside the main landmark so it is always present before messages arrive. */
export function LiveRegion() {
  const { message, clear } = useAnnouncer();
  return (
    <div className="live-region-wrap">
      <div role="status" aria-live="polite" aria-atomic="true" className={message ? "notice notice-result" : "visually-hidden"} data-testid="live-region">
        {message}
      </div>
      {message ? (
        <button type="button" className="button-link" onClick={clear}>
          Dismiss result message
        </button>
      ) : null}
    </div>
  );
}
