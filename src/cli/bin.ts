#!/usr/bin/env node
// The bin. Everything else lives in the modules this dispatches to; keeping the
// entry this small is what makes `prefaix run` a fast start (DESIGN §9).

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main } from "./index.js";
import type { ExitCode } from "../core/errors.js";

/**
 * The running version, read from the package rather than a generated constant,
 * so a bundled build and the source tree cannot disagree about which version is
 * running.
 */
export function cliVersion(
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): string {
  try {
    const here = fileURLToPath(
      new URL("../../../package.json", import.meta.url),
    );
    const parsed = JSON.parse(read(here)) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function runCli(
  argv: readonly string[],
  version: string = cliVersion(),
): Promise<ExitCode> {
  return main({ argv, version });
}

/** True when this module is the process entry rather than an import. */
export function isEntry(url: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }
  try {
    return pathToFileURL(argv1).href === url;
  } catch {
    return false;
  }
}

if (isEntry(import.meta.url, process.argv[1])) {
  // The terminal is already back in cooked mode by the time this resolves: the
  // client restores it on every exit path, including the ones that threw.
  process.exitCode = await runCli(process.argv.slice(2));
}
