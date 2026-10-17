import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ConsoleApiClient } from "./api/client";
import { createMemoryTokenStore } from "./api/token";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

// Same-origin API (the Vite dev server proxies /console/api to the local platform).
const client = new ConsoleApiClient({ tokenStore: createMemoryTokenStore() });

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App client={client} />
    </BrowserRouter>
  </StrictMode>,
);
