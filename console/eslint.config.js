import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { builtinModules } from "node:module";
import globals from "globals";
import { vspPlugin } from "../platform/eslint.config.js";

/**
 * Console lint rules. Beyond the recommended sets, these encode console security
 * rules (spec sections 6 and 16, docs/ARCHITECTURE.md conventions):
 *  - the bearer token lives in memory only: browser storage and cookies are banned
 *    (the transient PKCE round-trip state in src/auth/pkce.ts is the one exception);
 *  - no raw HTML injection, no eval or route to the Function constructor (the `Function` global or a
 *    `constructor` member, vsp/no-function-constructor), no console output (console output can leak data);
 *  - HTTP-only (platform/architecture/modules.yaml, docs/ARCHITECTURE.md section 6.4 rule 5): the console
 *    imports no platform code except the console API contract (types and route constants), no Node
 *    built-in and no server library; vsp/module-boundaries is the same rule platform/ uses (FO-03-11).
 */
const HTTP_ONLY = "The console is HTTP-only: it reaches the platform through the console API, never by importing server code (FO-03-11).";
const storageMessage =
  "Browser storage is banned in the console: the bearer token is held in memory only (src/api/token.ts). Transient PKCE state lives only in src/auth/pkce.ts.";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser, parserOptions: { tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: storageMessage },
        { name: "sessionStorage", message: storageMessage },
        { name: "indexedDB", message: storageMessage },
        { name: "Function", message: "No code from strings: the Function constructor is banned however it is reached (FO-06-22)." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "window", property: "localStorage", message: storageMessage },
        { object: "window", property: "sessionStorage", message: storageMessage },
        { object: "globalThis", property: "localStorage", message: storageMessage },
        { object: "globalThis", property: "sessionStorage", message: storageMessage },
        { object: "document", property: "cookie", message: storageMessage },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Raw HTML injection is banned in the console.",
        },
        {
          selector: "MemberExpression[property.name='innerHTML']",
          message: "Raw HTML injection is banned in the console.",
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/test/**"],
    plugins: { vsp: vspPlugin },
    rules: {
      "vsp/module-boundaries": "error",
      "vsp/no-function-constructor": "error",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          // Bare built-in names (`child_process`, `fs/promises`) by exact name; `node:` specifiers by pattern.
          paths: [{ name: "@vsp/platform", message: HTTP_ONLY }, ...builtinModules.filter((n) => !n.startsWith("_")).map((name) => ({ name, message: HTTP_ONLY }))],
          patterns: [
            { group: ["node:*", "node:*/**"], message: HTTP_ONLY },
            { group: ["@aws-sdk/*", "@smithy/*", "pg", "pg-*", "@electric-sql/*", "@livekit/*", "livekit-server-sdk"], message: HTTP_ONLY },
          ],
        },
      ],
    },
  },
  {
    // The only module allowed to touch sessionStorage: PKCE verifier/state/nonce for one redirect round-trip.
    files: ["src/auth/pkce.ts"],
    rules: { "no-restricted-globals": "off", "no-restricted-properties": "off" },
  },
  {
    // Tests assert that storage stays empty.
    files: ["src/**/*.test.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
    rules: { "no-restricted-globals": "off", "no-restricted-properties": "off" },
  },
);
