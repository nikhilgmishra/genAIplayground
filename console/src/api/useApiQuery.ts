import { useCallback, useEffect, useState } from "react";
import { toConsoleApiError } from "./client";
import type { ConsoleApiError } from "./client";

export interface QueryState<T> {
  data: T | null;
  error: ConsoleApiError | null;
  loading: boolean;
  reload: () => void;
  /** Replace the loaded data locally (e.g. after a mutation response). */
  setData: (updater: (prev: T | null) => T | null) => void;
}

/** Loads data once per `deps` change; errors are reduced to reason codes. */
export function useApiQuery<T>(load: (() => Promise<T>) | null, deps: readonly unknown[]): QueryState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ConsoleApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(load !== null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!load) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    load().then(
      (value) => {
        if (cancelled) return;
        setDataState(value);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(toConsoleApiError(err));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // `load` is recreated every render; `deps` and `generation` decide when to refetch.
  }, [...deps, generation]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  const setData = useCallback((updater: (prev: T | null) => T | null) => setDataState((prev) => updater(prev)), []);
  return { data, error, loading, reload, setData };
}
