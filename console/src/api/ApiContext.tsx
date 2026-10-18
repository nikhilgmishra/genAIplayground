import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { ConsoleApiClient } from "./client";

const ApiContext = createContext<ConsoleApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ConsoleApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ConsoleApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error("ApiProvider missing");
  return client;
}
