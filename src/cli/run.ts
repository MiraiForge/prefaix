import {
  EXIT,
  PrefaixError,
  type ExitCode,
  messageOf,
} from "../core/errors.js";
import { resolvePaths } from "../core/paths.js";
import { run } from "../client/run.js";
import type { CliOptions } from "./index.js";

/** Dispatch a client turn without loading the other CLI command parsers. */
export async function runClient(options: CliOptions): Promise<ExitCode> {
  const env = options.env ?? process.env;
  const paths = options.paths ?? resolvePaths({ env });
  const out = options.out ?? ((text: string) => process.stdout.write(text));
  const err = options.err ?? ((text: string) => process.stderr.write(text));
  try {
    return await run({
      argv: options.argv,
      version: options.version,
      env,
      paths,
      out,
      err,
      doctor: async (args) => {
        const { runDoctor } = await import("./doctor.js");
        return runDoctor({
          env,
          paths,
          out,
          err,
          shell: args.shell,
          shellVersion: args.shellVersion,
          pluginLoaded: env["PREFAIX_PLUGIN_LOADED"] === "1",
        });
      },
      ...(options.isTty === undefined ? {} : { stdoutIsTty: options.isTty }),
      ...(options.cols === undefined ? {} : { cols: options.cols }),
      ...(options.rows === undefined ? {} : { rows: options.rows }),
      ...(options.tty === undefined ? {} : { tty: options.tty }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.connect === undefined ? {} : { connect: options.connect }),
    });
  } catch (cause) {
    err(`${messageOf(cause)}\n`);
    if (cause instanceof PrefaixError && cause.hint !== undefined)
      err(`${cause.hint}\n`);
    return cause instanceof PrefaixError ? cause.exitCode : EXIT.agentError;
  }
}
