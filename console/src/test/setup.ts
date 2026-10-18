import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// The default 1 s wait is too tight when the shared machine is loaded; behaviour is unchanged.
configure({ asyncUtilTimeout: 5_000 });

// Mirrors index.html so document-level accessibility rules see the real page language.
document.documentElement.lang = "en";

// jsdom has no canvas; axe-core probes it for icon-ligature checks. Report "no canvas" quietly.
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  document.title = "";
});
