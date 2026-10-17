import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='console'][callee.property.name='log']",
          message: "Use the redacting logger in src/observability; console.log can leak PHI.",
        },
      ],
    },
  },
  {
    files: ["src/demo/**/*.ts", "src/evaluation/cli.ts", "src/main/**/*.ts", "src/protocol/generate-schemas.ts", "src/**/cli*.ts"],
    rules: { "no-console": "off", "no-restricted-syntax": "off" },
  },
);
