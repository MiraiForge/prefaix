import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  CONFIG_SCHEMA,
  envNameFor,
  type Members,
} from "../src/core/config/schema.js";

export function configReference(): string {
  const rows: string[] = [];
  function visit(members: Members, prefix = ""): void {
    for (const [name, node] of Object.entries(members)) {
      const path = prefix === "" ? name : `${prefix}.${name}`;
      if (node.type === "section") {
        visit(node.members, path);
      } else if (node.type === "map") {
        visit(node.entry, `${path}.<name>`);
      } else {
        const type = node.values?.join(" / ") ?? node.kind;
        const value = JSON.stringify(node.default);
        const env = [envNameFor(path), ...(node.aliases ?? [])].join("`, `");
        rows.push(
          `| \`${path}\` | ${type}${node.min === undefined ? "" : ` (minimum ${String(node.min)})`} | \`${value.replaceAll("|", "\\|")}\` | \`${env}\` |`,
        );
      }
    }
  }
  visit(CONFIG_SCHEMA.members);
  return `# Configuration reference\n\nGenerated from \`src/core/config/schema.ts\` by \`bun run docs:config\`.\nDo not edit this table by hand.\n\nEvery key is optional. Configuration lives at \`$XDG_CONFIG_HOME/prefaix/config.toml\`\n(or \`~/.config/prefaix/config.toml\`). Run \`prefaix config check\` after editing.\nEnvironment overrides use strings: booleans accept \`true/false\` or \`1/0\`,\nlists use JSON arrays, and paths expand a leading \`~\`. Unknown keys are errors.\n\n| TOML key | Type / accepted values | Default | Environment override |\n|---|---|---|---|\n${rows.join("\n")}\n\n\`personas.<name>\` is an extensible table. The default \`ask\` and \`plan\` personas\nallow \`read\`, \`grep\`, \`find\`, and \`ls\`; ask answers without editing, and plan\nproduces a plan without editing. A configured persona replaces its default entry.\nAn environment override can alter an existing persona but cannot introduce one.\n\n\`null\` means unset. \`PREFAIX_PLAIN=1\` disables styling. Shell identity, live-test\nsettings, and \`PREFAIX_FAKE_SCENARIO\` are runtime controls, not TOML settings.\nSome settings prepare later milestones: \`commands.suggest\`, \`commands.commit\`,\nand \`ui.set_title\` do not enable those M4 features in the M3 build.\n`;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const target = "docs/CONFIGURATION.md";
  const generated = configReference();
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== generated) {
      throw new Error(
        "Configuration reference is stale; run bun run docs:config.",
      );
    }
  } else {
    writeFileSync(target, generated);
  }
}
