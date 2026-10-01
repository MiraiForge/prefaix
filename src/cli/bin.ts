#!/usr/bin/env node
// The bin. Everything else lives in the modules this dispatches to; keeping the
// entry this small is what makes `prefaix run` a fast start (DESIGN §9).

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareDaemonRuntime } from "./daemon-runtime.js";
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
      new URL(
        import.meta.url.endsWith("/src/cli/bin.ts")
          ? "../../package.json"
          : "../package.json",
        import.meta.url,
      ),
    );
    const parsed = JSON.parse(read(here)) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function runCli(
  argv: readonly string[],
  version: string = cliVersion(),
): Promise<ExitCode> {
  if (argv[0] === "run") {
    const { runClient } = await import("./run.js");
    return runClient({ argv: argv.slice(1), version });
  }
  const { main } = await import("./index.js");
  return main({ argv, version });
}

/** True when this module is the process entry rather than an import. */
export function isEntry(url: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(argv1)).href === url;
  } catch {
    return false;
  }
}

if (isEntry(import.meta.url, process.argv[1])) {
  // Reuse compiled client chunks between short-lived turns. Node honors its
  // cache/disable environment settings and treats an unavailable cache as optional.
  if (process.argv[2] === "run" && process.versions["bun"] === undefined)
    process
      .getBuiltinModule("module")
      .enableCompileCache(process.env["NODE_COMPILE_CACHE"]);
  // The terminal is already back in cooked mode by the time this resolves: the
  // client restores it on every exit path, including the ones that threw.
  process.exitCode =
    prepareDaemonRuntime() ?? (await runCli(process.argv.slice(2)));
}
