import { defaultConfig, type PrefaixConfig } from "../../core/config/schema.js";
import { resolvePaths, type PrefaixPaths } from "../../core/paths.js";
import { DEFAULT_PASSTHROUGH } from "../grammar.js";
import { BASH_PLUGIN } from "./bash.js";
import { FISH_PLUGIN } from "./fish.js";
import { ZSH_PLUGIN } from "./zsh.js";

export type PluginShell = "zsh" | "fish" | "bash";
export interface InitShellOptions {
  config?: PrefaixConfig;
  paths?: PrefaixPaths;
}

/** Shell literals contain data only, including paths and user-supplied regexes. */
function quote(value: string, shell: PluginShell): string {
  if (value.includes("\0"))
    throw new Error("Shell configuration cannot contain NUL");
  return shell === "fish"
    ? `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Embedded scripts also work from the single-file npm bundle. */
export function initShell(
  shell: PluginShell,
  options: InitShellOptions = {},
): string {
  const config = options.config ?? defaultConfig();
  const paths = options.paths ?? resolvePaths();
  const pattern =
    shell === "fish"
      ? config.grammar.passthrough
      : config.grammar.passthrough
          .replaceAll("\\s", "[[:space:]]")
          .replaceAll("(?:", "(");
  const values = {
    runtime: paths.runtimeDir,
    passthrough: pattern,
    limit: String(config.context.recentCommands),
    classify: config.grammar.passthrough === DEFAULT_PASSTHROUGH ? "0" : "1",
    classify_hint: "^:[[:space:]]*([^[:alnum:][:space:]_]|$)",
    rprompt: config.ui.rprompt,
    osc_mode: config.ui.osc133,
  };
  const settings = Object.entries(values)
    .map(([key, value]) =>
      shell === "fish"
        ? `set -g __prefaix_${key} ${quote(value, shell)}`
        : `__prefaix_${key}=${quote(value, shell)}`,
    )
    .join("\n");
  return `${settings}\n${{ zsh: ZSH_PLUGIN, fish: FISH_PLUGIN, bash: BASH_PLUGIN }[shell]}`;
}
