// `prefaix config check`: validate the config file and the PREFAIX_* overrides
// and print the settings that are not at their defaults. The dispatcher in
// M2-11 wires this to argv; the logic lives here so it is testable without a
// process.

import { readFileSync } from "node:fs";
import { EXIT, type ExitCode, messageOf } from "../core/errors.js";
import { resolvePaths } from "../core/paths.js";
import {
  describeConfig,
  renderDiagnostics,
  resolveConfig,
  type ReadFile,
} from "../core/config/index.js";

export interface ConfigCheckOptions {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly file?: string;
  readonly readFile?: ReadFile;
  readonly home?: string;
}

/**
 * Reads the config, distinguishing "not there" from "there but unreadable".
 * A permission error reported as a missing file would print `config ok`
 * against the defaults, which is the worst possible answer.
 */
function defaultReadFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") {
      return undefined;
    }
    throw cause;
  }
}

export function runConfigCheck(options: ConfigCheckOptions): ExitCode {
  const file = options.file ?? resolvePaths().configFile;
  let text: string | undefined;
  try {
    text = (options.readFile ?? defaultReadFile)(file);
  } catch (cause) {
    options.err(`${file}: cannot be read (${messageOf(cause)})`);
    options.err("Fix the permissions, or delete the file to use the defaults.");
    return EXIT.agentError;
  }
  const resolved = resolveConfig({
    text: text ?? "",
    env: options.env ?? {},
    ...(options.home === undefined ? {} : { home: options.home }),
  });

  if (resolved.diagnostics.length > 0) {
    const count = resolved.diagnostics.length;
    options.err(
      renderDiagnostics(resolved.diagnostics, {
        file,
        ...(text === undefined ? {} : { text }),
      }),
    );
    options.err(
      `${file}: ${count} problem${count === 1 ? "" : "s"} found. Fix them, or delete the file to use the defaults.`,
    );
    return EXIT.usage;
  }

  const lines = describeConfig(resolved, { file });
  options.out(`config ok: ${file}`);
  if (lines.length === 0) {
    options.out("every setting is at its default.");
    return EXIT.ok;
  }
  options.out("\nsettings that are not defaults:");
  for (const line of lines) {
    options.out(line);
  }
  return EXIT.ok;
}
