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
import type { run } from "../client/run.js";
import type { runDaemon } from "./daemon.js";
import type { RawModeTarget } from "../client/tty.js";

export const USAGE = `prefaix — a coding agent at your shell prompt

usage:
  prefaix run [flags] -- '<raw line>'   run one turn (the shell plugin calls this)
  prefaix daemon start|stop|status      manage the long-lived daemon
  prefaix conversations ls|show|rm      list, show, and remove conversations
  prefaix config check                  validate the config file
  prefaix init zsh|fish|bash             print the shell integration
  prefaix setup [--shell <name>]        preview and install the rc line
  prefaix uninstall [--shell <name>]    remove the managed rc line
  prefaix doctor                        diagnose this installation
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
      case "classify": {
        if (rest.length !== 2 || rest[0] !== "--") {
          err("usage: prefaix classify -- '<raw line>'\n");
          return EXIT.usage;
        }
        const { loadConfig } = await import("../core/config/index.js");
        const { parseLine } = await import("../shells/grammar.js");
        const config = loadConfig({ env, file: paths.configFile });
        return parseLine(rest[1]!, {
          passthrough: config.grammar.passthrough,
          personas: Object.keys(config.personas),
        }).kind === "pass"
          ? EXIT.agentError
          : EXIT.ok;
      }
      case "init": {
        const shell = rest[0];
        if (
          rest.length !== 1 ||
          (shell !== "zsh" && shell !== "fish" && shell !== "bash")
        ) {
          err("usage: prefaix init zsh|fish|bash\n");
          return EXIT.usage;
        }
        const { initShell } = await import("../shells/plugins/index.js");
        const { loadConfig } = await import("../core/config/index.js");
        out(
          initShell(shell, {
            config: loadConfig({ env, file: paths.configFile }),
            paths,
          }),
        );
        return EXIT.ok;
      }
      case "setup":
      case "uninstall": {
        const { runSetup, runUninstall } = await import("./setup.js");
        return await (command === "setup" ? runSetup : runUninstall)(rest, {
          env,
          out,
          err,
        });
      }
      case "doctor": {
        const { runDoctor } = await import("./doctor.js");
        if (rest.length > 0) {
          err("usage: prefaix doctor\n");
          return EXIT.usage;
        }
        return await runDoctor({ env, paths, out, err });
      }
      case "run": {
        const { runClient } = await import("./run.js");
        return await runClient({
          ...options,
          argv: rest,
          env,
          paths,
          out,
          err,
        });
      }
      case "daemon": {
        const { runDaemon } = await import("./daemon.js");
        return await (options.daemon ?? runDaemon)(rest, {
          env,
          paths,
          out,
          err,
          version: options.version,
        });
      }
      case "conversations":
      case "convs": {
        const { runConversations } = await import("./conversations.js");
        return await runConversations(rest, {
          env,
          paths,
          out,
          err,
          version: options.version,
        });
      }
      case "config":
        return await runConfigSubcommand(rest, { env, paths, out, err });
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

async function runConfigSubcommand(
  argv: readonly string[],
  io: {
    env: Readonly<Record<string, string | undefined>>;
    paths: PrefaixPaths;
    out: (text: string) => void;
    err: (text: string) => void;
  },
): Promise<ExitCode> {
  const [sub, ...rest] = argv;
  if (sub === "check") {
    const { runConfigCheck } = await import("./config.js");
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
    const { runTap } = await import("./conversations.js");
    return runTap(target, io);
  }
  io.err(`prefaix debug: unknown subcommand ${JSON.stringify(sub ?? "")}\n`);
  io.err("usage: prefaix debug tap <conversation>\n");
  return EXIT.usage;
}

export { parseArgs };
