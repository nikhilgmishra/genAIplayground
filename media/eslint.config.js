import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import { GLOBAL_ACCESS_OPTIONS, RESTRICTED_GLOBALS, RESTRICTED_IMPORTS, restrictedImportOptions, vspPlugin } from "../platform/eslint.config.js";

/*
 * Media runtime lint rules (lint group: WP-06 then WP-07 in phase B; sources arrive with WP-11 to WP-17).
 * media/ is in the untrusted-output group of platform/architecture/modules.yaml (docs/ARCHITECTURE.md
 * section 6.4 rule 1): it reaches the platform only through the modules its register entry allows and
 * never through a write port, the connector runtime or a secret store.
 *   - vsp/module-boundaries: the same register and rule as platform/ (FO-03-11);
 *   - no raw network clients: outbound HTTP goes through the egress-classified transport
 *     (platform/src/connectors/http); the LiveKit SDK owns its own media sockets (FO-06-20, FO-15-19).
 *     Deep imports of a restricted package (`undici/lib/...`) and DNS are refused too, and the global
 *     object is read only through static, non-network members (vsp/no-raw-global-access);
 *   - no eval, new Function (nor a route to it through a `constructor` member or the `Function` global),
 *     child_process, vm, worker_threads, node:module (createRequire), require, process.binding /
 *     getBuiltinModule or dynamic import (FO-06-22); these bans cover fixtures too (only test files are exempt);
 *   - no Secrets Manager or KMS client: media holds no long-lived credential (FO-06-04).
 */
const SECRETS_MESSAGE = "media/ holds no long-lived credential: secrets are resolved by the platform SecretResolver (FO-06-04).";
const PROCESS_MESSAGE = "No dynamic shell or code loading in media/ (FO-06-22).";

export const MEDIA_RESTRICTED_IMPORTS = [
  ...RESTRICTED_IMPORTS.filter((p) => p.name !== "@aws-sdk/client-secrets-manager"),
  { name: "@aws-sdk/client-secrets-manager", message: SECRETS_MESSAGE },
  { name: "@aws-sdk/client-kms", message: SECRETS_MESSAGE },
  { name: "@aws-sdk/client-ssm", message: SECRETS_MESSAGE },
];

const TEST_SUPPORT = ["src/**/*.test.ts", "src/**/*.fixture.ts", "src/**/testing.ts", "src/**/fixtures/**", "src/**/testing/**", "test/**"];
// The capability bans exempt test files only: fixtures and testing helpers can be imported by production code.
const TEST_FILES = ["src/**/*.test.ts", "test/**"];

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node, parserOptions: { tsconfigRootDir: import.meta.dirname } },
    plugins: { vsp: vspPlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: TEST_FILES,
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", restrictedImportOptions(MEDIA_RESTRICTED_IMPORTS)],
      "no-restricted-globals": ["error", ...RESTRICTED_GLOBALS],
      "vsp/no-raw-global-access": ["error", GLOBAL_ACCESS_OPTIONS],
      "vsp/no-function-constructor": "error",
      "no-restricted-syntax": ["error", { selector: "ImportExpression", message: PROCESS_MESSAGE }],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: TEST_SUPPORT,
    rules: { "vsp/module-boundaries": "error" },
  },
);
