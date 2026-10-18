import type { ReactNode } from "react";
import type { QueryState } from "../api/useApiQuery";
import { ErrorNotice } from "./ErrorNotice";

/** Loading / error / data rendering for a query. */
export function QueryView<T>({ query, label, children }: { query: QueryState<T>; label: string; children: (data: T) => ReactNode }) {
  if (query.loading && query.data === null) return <p className="loading">Loading {label}…</p>;
  if (query.error && query.data === null) return <ErrorNotice error={query.error} context={`Could not load ${label}.`} />;
  if (query.data === null) return null;
  return (
    <>
      {query.error ? <ErrorNotice error={query.error} context={`Could not refresh ${label}.`} /> : null}
      {children(query.data)}
    </>
  );
}
