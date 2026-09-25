import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const agentsDirectory = fileURLToPath(
  new URL("../../src/agents/", import.meta.url),
);

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      crossAdapter:
        "Only src/agents/registry.ts may wire different concrete adapters together.",
    },
  },
  create(context) {
    const importer = relative(agentsDirectory, context.filename).split(sep);
    const adapter = importer.length > 1 ? importer[0] : undefined;

    function check(source) {
      const specifier =
        source?.type === "Literal"
          ? source.value
          : source?.type === "TemplateLiteral" &&
              source.expressions.length === 0
            ? source.quasis[0]?.value.cooked
            : undefined;
      if (
        typeof specifier !== "string" ||
        (!specifier.startsWith(".") && !isAbsolute(specifier))
      ) {
        return;
      }
      const target = relative(
        agentsDirectory,
        resolve(dirname(context.filename), specifier),
      ).split(sep);
      if (target[0] !== ".." && target.length > 1 && target[0] !== adapter) {
        context.report({ node: source, messageId: "crossAdapter" });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      "TSImportType Literal": check,
    };
  },
};
