// `prefaix` argv and subcommands (DESIGN §11, §4.2).
//
// One bundled file, one dispatcher, and a `parseArgs`-based parser. Every
// subcommand is a function that returns an exit code, so the whole CLI is
// testable without a process and the bin stays a three-line shim.

import { parseArgs } from "node:util";
import {
  EXIT,
  PrefaixError,
  type ExitCode,
  messageOf,
} from "../core/errors.js";
import { resolvePaths } from "../core/paths.js";
import type { PrefaixPaths } from "../core/paths.js";
import { runConfigCheck } from "./config.js";
import { run } from "../client/run.js";
import { runDaemon, daemonStatus, stopDaemon } from "./daemon.js";
import { runConversations, runTap } from "./conversations.js";
import type { RawModeTarget } from "../client/tty.js";

export const USAGE = `prefaix — a coding agent at your shell prompt

usage:
  prefaix run [flags] -- '<raw line>'   run one turn (the shell plugin calls this)
  prefaix daemon start|stop|status      manage the long-lived daemon
  prefaix conversations ls|show|rm      list, show, and remove conversations
  prefaix config check                  validate the config file
  prefaix debug tap <conversation>      print a conversation's raw events
  prefaix --version                     print the version
  prefaix --help                        this text

common flags:
  --backend <id>        pi (default) or fake
`;

export interface CliOptions {
  readonly argv: readonly string[];
  readonly version: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly paths?: PrefaixPaths;
  readonly out?: (text: string) => void;
  readonly err?: (text: string) => void;
  readonly isTty?: boolean;
  readonly cols?: number;
  readonly rows?: number;
  readonly tty?: RawModeTarget;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected so a test can put a fake daemon on the other end. */
  readonly connect?: Parameters<typeof run>[0]["connect"];
  readonly daemon?: typeof runDaemon;
}

export async function main(options: CliOptions): Promise<ExitCode> {
  const env = options.env ?? process.env;
  const out = options.out ?? ((text: string) => process.stdout.write(text));
  const err = options.err ?? ((text: string) => process.stderr.write(text));
  const argv = [...options.argv];
  const [command, ...rest] = argv;

  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    out(USAGE);
    return EXIT.ok;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    out(`${options.version}\n`);
    return EXIT.ok;
  }

  const paths = options.paths ?? resolvePaths({ env });
  try {
    switch (command) {
      case "run":
        return await run({
          argv: rest,
          version: options.version,
          env,
          paths,
          out,
          err,
          ...(options.isTty === undefined
            ? {}
            : { stdoutIsTty: options.isTty }),
          ...(options.cols === undefined ? {} : { cols: options.cols }),
          ...(options.rows === undefined ? {} : { rows: options.rows }),
          ...(options.tty === undefined ? {} : { tty: options.tty }),
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
          ...(options.connect === undefined
            ? {}
            : { connect: options.connect }),
        });
      case "daemon":
        return await (options.daemon ?? runDaemon)(rest, {
          env,
          paths,
          out,
          err,
          version: options.version,
        });
      case "conversations":
      case "convs":
        return await runConversations(rest, {
          env,
          paths,
          out,
          err,
          version: options.version,
        });
      case "config":
        return runConfigSubcommand(rest, { env, paths, out, err });
      case "debug":
        return await runDebugSubcommand(rest, {
          env,
          paths,
          out,
          err,
          version: options.version,
        });
      default:
        err(`prefaix: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
        return EXIT.usage;
    }
  } catch (cause) {
    err(`${messageOf(cause)}\n`);
    if (cause instanceof PrefaixError && cause.hint !== undefined) {
      err(`${cause.hint}\n`);
    }
    return cause instanceof PrefaixError ? cause.exitCode : EXIT.agentError;
  }
}

function runConfigSubcommand(
  argv: readonly string[],
  io: {
    env: Readonly<Record<string, string | undefined>>;
    paths: PrefaixPaths;
    out: (text: string) => void;
    err: (text: string) => void;
  },
): ExitCode {
  const [sub, ...rest] = argv;
  if (sub === "check") {
    const fileIndex = rest.indexOf("--file");
    const file = fileIndex === -1 ? undefined : rest[fileIndex + 1];
    return runConfigCheck({
      out: (line) => io.out(`${line}\n`),
      err: (line) => io.err(`${line}\n`),
      env: io.env,
      ...(file === undefined ? {} : { file }),
    });
  }
  io.err(`prefaix config: unknown subcommand ${JSON.stringify(sub ?? "")}\n`);
  io.err("usage: prefaix config check\n");
  return EXIT.usage;
}

async function runDebugSubcommand(
  argv: readonly string[],
  io: {
    env: Readonly<Record<string, string | undefined>>;
    paths: PrefaixPaths;
    out: (text: string) => void;
    err: (text: string) => void;
    version: string;
  },
): Promise<ExitCode> {
  const [sub, target] = argv;
  if (sub === "tap") {
    if (target === undefined || target === "") {
      io.err("prefaix debug tap: a conversation id is required\n");
      return EXIT.usage;
    }
    return runTap(target, io);
  }
  io.err(`prefaix debug: unknown subcommand ${JSON.stringify(sub ?? "")}\n`);
  io.err("usage: prefaix debug tap <conversation>\n");
  return EXIT.usage;
}

export { daemonStatus, stopDaemon, parseArgs };
