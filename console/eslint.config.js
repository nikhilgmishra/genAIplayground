import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Console lint rules. Beyond the recommended sets, these encode console security
 * rules (spec sections 6 and 16, docs/ARCHITECTURE.md conventions):
 *  - the bearer token lives in memory only: browser storage and cookies are banned
 *    (the transient PKCE round-trip state in src/auth/pkce.ts is the one exception);
 *  - no raw HTML injection, no eval, no console output (console output can leak data).
 */
const storageMessage =
  "Browser storage is banned in the console: the bearer token is held in memory only (src/api/token.ts). Transient PKCE state lives only in src/auth/pkce.ts.";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
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
