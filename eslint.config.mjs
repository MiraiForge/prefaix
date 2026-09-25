import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";
import adapterBoundary from "./scripts/eslint-rules/adapter-boundary.mjs";

function boundary(regex, message) {
  const selectorPattern = regex.replaceAll("/", "\\/");
  return {
    "no-restricted-imports": [
      "error",
      { patterns: [{ regex, caseSensitive: true, message }] },
    ],
    "no-restricted-syntax": [
      "error",
      {
        selector: `ImportExpression[source.value=/${selectorPattern}/]`,
        message,
      },
      {
        selector: `ImportExpression[source.type='TemplateLiteral'][source.expressions.length=0] TemplateElement[value.cooked=/${selectorPattern}/]`,
        message,
      },
      {
        selector: `TSImportType Literal[value=/${selectorPattern}/]`,
        message,
      },
    ],
  };
}

export default defineConfig([
  globalIgnores([
    "dist/**",
    "coverage/**",
    ".beads/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/agents/**"],
    rules: boundary(
      "(^|/)agents($|/(?!registry(?:\\.[cm]?[jt]s)?$))",
      "Import concrete adapters only through src/agents/registry.ts.",
    ),
  },
  {
    files: ["src/{client,shells,core}/**/*.ts"],
    rules: boundary(
      "(^|/)agents(/|$)",
      "This layer must not import agents; use backend-independent core contracts.",
    ),
  },
  {
    files: ["src/agents/**/*.ts"],
    ignores: ["src/agents/registry.ts"],
    plugins: {
      architecture: { rules: { "adapter-boundary": adapterBoundary } },
    },
    rules: { "architecture/adapter-boundary": "error" },
  },
  prettier,
]);
