/** Test harness: renders the real App with the mock backend and an in-memory token. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { App } from "../App";
import { ConsoleApiClient } from "../api/client";
import type { StaffView } from "../api/contract";
import { createMemoryTokenStore } from "../api/token";
import { staffView } from "./fixtures";
import { createMockApi } from "./mock-api";
import type { MockApi } from "./mock-api";

function LocationProbe({ onChange }: { onChange: (path: string) => void }) {
  const location = useLocation();
  useEffect(() => {
    onChange(`${location.pathname}${location.search}`);
  }, [location, onChange]);
  return null;
}

export interface RenderConsoleOptions {
  path?: string;
  staff?: StaffView;
  signedIn?: boolean;
  api?: MockApi;
  redirect?: (url: string) => void;
}

export function renderConsole(options: RenderConsoleOptions = {}) {
  const staff = options.staff ?? staffView("supervisor");
  const api = options.api ?? createMockApi();
  api.registerStaff(staff);
  const tokens = createMemoryTokenStore();
  if (options.signedIn !== false) tokens.set(api.tokenFor(staff), "2099-01-01T00:00:00.000Z");
  const client = new ConsoleApiClient({ tokenStore: tokens, fetchImpl: api.fetch });
  const user = userEvent.setup();
  const locations: string[] = [];
  const view = render(
    <MemoryRouter initialEntries={[options.path ?? "/"]}>
      <App client={client} redirect={options.redirect ?? (() => undefined)} origin="http://console.test" />
      <LocationProbe onChange={(p) => locations.push(p)} />
    </MemoryRouter>,
  );
  return { ...view, user, api, tokens, client, staff, locations };
}

/** Waits for the signed-in shell and the page heading. */
export async function findPage(heading: string | RegExp): Promise<HTMLElement> {
  return screen.findByRole("heading", { level: 1, name: heading });
}
