import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

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
