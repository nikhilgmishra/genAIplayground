import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { builtinModules } from "node:module";
import globals from "globals";
import { vspPlugin } from "../platform/eslint.config.js";

/*
 * Caller companion lint rules (lint group: WP-06 then WP-07 in phase B; sources arrive with WP-27).
 * companion/ is an HTTP-only package (platform/architecture/modules.yaml, docs/ARCHITECTURE.md section
 * 6.4 rule 5): it talks to the gateway over HTTP and imports no platform code beyond the gateway client
 * contract, no Node built-in, no AWS SDK and no server library (FO-03-11, FO-06-20, FO-06-22).
 * It keeps the console's browser rules: no browser storage for tokens, no raw HTML, no eval, and no route to
 * the Function constructor (the `Function` global or a `constructor` member, vsp/no-function-constructor).
 */
const HTTP_ONLY = "companion/ is HTTP-only: it reaches the platform through the gateway API, never by importing server code (FO-03-11).";
const STORAGE = "Browser storage is banned in the companion: any session token is held in memory only.";
const CODE_LOADING = "No code from strings: the Function constructor is banned however it is reached (FO-06-22).";

export const COMPANION_RESTRICTED_IMPORTS = {
  // Bare built-in names (`child_process`, `fs/promises`) by exact name; `node:` specifiers by pattern.
  paths: [{ name: "@vsp/platform", message: HTTP_ONLY }, ...builtinModules.filter((n) => !n.startsWith("_")).map((name) => ({ name, message: HTTP_ONLY }))],
  patterns: [
    { group: ["node:*", "node:*/**"], message: HTTP_ONLY },
    { group: ["@aws-sdk/*", "@smithy/*", "pg", "pg-*", "@electric-sql/*", "@livekit/*", "livekit-server-sdk"], message: HTTP_ONLY },
  ],
};

const TEST_SUPPORT = ["src/**/*.test.{ts,tsx}", "src/test/**", "e2e/**"];

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "playwright-report/**", "test-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser, parserOptions: { tsconfigRootDir: import.meta.dirname } },
    plugins: { vsp: vspPlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: TEST_SUPPORT,
    rules: {
      "vsp/module-boundaries": "error",
      "@typescript-eslint/no-restricted-imports": ["error", COMPANION_RESTRICTED_IMPORTS],
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: STORAGE },
        { name: "sessionStorage", message: STORAGE },
        { name: "indexedDB", message: STORAGE },
        { name: "Function", message: CODE_LOADING },
      ],
      "vsp/no-function-constructor": "error",
      "no-restricted-properties": [
        "error",
        { object: "window", property: "localStorage", message: STORAGE },
        { object: "window", property: "sessionStorage", message: STORAGE },
        { object: "document", property: "cookie", message: STORAGE },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Raw HTML injection is banned in the companion." },
        { selector: "MemberExpression[property.name='innerHTML']", message: "Raw HTML injection is banned in the companion." },
        { selector: "ImportExpression[source.type!='Literal']", message: "Computed dynamic import is banned (FO-06-22)." },
      ],
    },
  },
);
