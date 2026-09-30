import { EXIT, type ExitCode } from "../core/errors.js";

export const DAEMON_NODE_FLAGS = [
  "--jitless",
  "--max-semi-space-size=1",
] as const;

interface RuntimeOptions {
  readonly argv: readonly string[];
  readonly execArgv: readonly string[];
  readonly execPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly nodeVersion: string;
  readonly bun?: boolean;
  readonly execve?: (
    file: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => void;
  readonly err: (text: string) => void;
}

function currentRuntime(): RuntimeOptions {
  return {
    argv: process.argv,
    execArgv: process.execArgv,
    execPath: process.execPath,
    env: process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    bun: process.versions["bun"] !== undefined,
    ...(process.execve === undefined ? {} : { execve: process.execve }),
    err: (text) => {
      process.stderr.write(text);
    },
  };
}

/** Re-exec before any daemon resources exist; keep its pid and stdio, with no supervisor process. */
export function prepareDaemonRuntime(
  options: RuntimeOptions = currentRuntime(),
): ExitCode | undefined {
  const [entry, subcommand] = options.argv.slice(2);
  if (
    entry !== "daemon" ||
    (subcommand !== undefined &&
      subcommand !== "start" &&
      subcommand !== "--foreground")
  )
    return undefined;
  const [major, minor] = options.nodeVersion.split(".").map(Number);
  if (
    options.bun === true ||
    major === undefined ||
    minor === undefined ||
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    major < 22 ||
    (major === 22 && minor < 19) ||
    !["darwin", "linux"].includes(options.platform) ||
    options.execve === undefined
  ) {
    options.err(
      "prefaix daemon: starting the daemon requires Node 22.19 or newer on macOS or Linux with process.execve support.\n",
    );
    return EXIT.usage;
  }
  // A caller's explicit V8 choices are preserved. Defaults apply only when no
  // choice was passed; NODE_OPTIONS is never changed or passed to pi by us.
  const flags = DAEMON_NODE_FLAGS.filter((flag) =>
    flag === "--jitless"
      ? !options.execArgv.some((arg) => /^--(?:no-)?jitless(?:=|$)/.test(arg))
      : !options.execArgv.some((arg) =>
          /^--max[-_]semi[-_]space[-_]size(?:=|$)/.test(arg),
        ),
  );
  if (flags.length === 0) return undefined;
  try {
    options.execve(
      options.execPath,
      [
        options.execPath,
        ...flags,
        ...options.execArgv,
        ...options.argv.slice(1),
      ],
      options.env,
    );
    return undefined;
  } catch {
    options.err(
      "prefaix daemon: could not restart Node with the daemon memory settings. Check the Node executable and try again.\n",
    );
    return EXIT.daemonUnavailable;
  }
}
