// `prefaix daemon {start,stop,status,--foreground}` (DESIGN §4.3.1).
//
// `start` is the foreground process the autospawner runs; `--foreground` is the
// same thing attached to a terminal, which is what a user runs when the daemon
// will not come up. `status` and `stop` talk to a running daemon, because
// neither can be answered by looking at the filesystem.

import {
  EXIT,
  PrefaixError,
  type ExitCode,
  messageOf,
} from "../core/errors.js";
import { Daemon } from "../daemon/daemon.js";
import { loadConfig } from "../core/config/index.js";
import { resolvePaths } from "../core/paths.js";
import type { PrefaixPaths } from "../core/paths.js";
import { lockIsStale, readLockPid } from "../daemon/lock.js";
import { stat } from "node:fs/promises";

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly paths: PrefaixPaths;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly version?: string;
}

interface ExitSnapshot {
  version: string;
  backend: string;
  state: string;
  children: number;
}

export type RunDaemon = (
  argv: readonly string[],
  io: CliIo,
) => Promise<ExitCode>;

async function status(io: CliIo): Promise<ExitCode> {
  const pid = await readLockPid(io.paths.lock);
  if (pid === undefined) {
    io.out("no daemon lock; nothing is running\n");
    return EXIT.ok;
  }
  const socket = await socketInfo(io.paths.socket);
  io.out(`daemon pid ${String(pid)}\n`);
  io.out(
    `socket ${io.paths.socket}${socket === undefined ? " (missing)" : ""}\n`,
  );
  if (socket === undefined && (await lockIsStale(io.paths.lock))) {
    io.out(
      "state: stale lock, no socket; run `prefaix daemon stop` to clean it up\n",
    );
    return EXIT.ok;
  }
  // Autospawn is off for the same reason as `stop`: a status report about a
  // daemon that is not there should say so, not create one.
  const { DaemonClient } = await import("../client/connection.js");
  const client = new DaemonClient({
    paths: io.paths,
    version: io.version ?? "0.0.0",
    autospawn: false,
  });
  try {
    await client.connect();
    const snapshot = await client.call<ExitSnapshot>("status.get", {});
    io.out(
      `prefaix ${snapshot.version} · backend ${snapshot.backend} · ${snapshot.state} · ${String(snapshot.children)} warm\n`,
    );
    return EXIT.ok;
  } catch {
    io.out("state: the lock exists but the daemon is not answering\n");
    return EXIT.daemonUnavailable;
  } finally {
    client.close();
  }
}

export const runDaemon: RunDaemon = async (argv, io) => {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "start":
      return start(io, { foreground: rest.includes("--foreground") });
    case "--foreground":
      return start(io, { foreground: true });
    case "stop":
      return stop(io);
    case "status":
      return status(io);
    default:
      io.err(`prefaix daemon: unknown subcommand ${JSON.stringify(sub)}\n`);
      io.err("usage: prefaix daemon start|stop|status|--foreground\n");
      return EXIT.usage;
  }
};

async function start(
  io: CliIo,
  options: { foreground: boolean },
): Promise<ExitCode> {
  let config;
  try {
    // The file comes from the resolved paths, so XDG_CONFIG_HOME in the
    // environment is what decides which config this process reads.
    config = loadConfig({ env: io.env, file: io.paths.configFile });
  } catch (cause) {
    io.err(`${messageOf(cause)}\n`);
    return EXIT.usage;
  }
  const daemon = new Daemon({
    paths: io.paths,
    config,
    version: io.version ?? "0.0.0",
    env: io.env,
  });
  try {
    await daemon.start();
  } catch (cause) {
    const problem = messageOf(cause);
    io.err(`prefaix daemon: ${problem}\n`);
    if (cause instanceof PrefaixError && cause.hint !== undefined) {
      io.err(`${cause.hint}\n`);
    }
    return cause instanceof PrefaixError
      ? cause.exitCode
      : EXIT.daemonUnavailable;
  }
  if (options.foreground) {
    io.err(`prefaix daemon listening on ${io.paths.socket}\n`);
    await daemon.waitForStop();
    return EXIT.ok;
  }
  // The autospawner detached this process, so it must not keep the parent's
  // event loop alive; the unref'd timer in `start` is what lets node exit.
  return EXIT.ok;
}

async function stop(io: CliIo): Promise<ExitCode> {
  // Autospawn is off: `stop` must never start a daemon in order to stop it.
  const { DaemonClient } = await import("../client/connection.js");
  const client = new DaemonClient({
    paths: io.paths,
    version: io.version ?? "0.0.0",
    autospawn: false,
  });
  try {
    await client.connect();
    await client.call("daemon.stop", {});
    io.out("daemon stopping\n");
    return EXIT.ok;
  } catch (cause) {
    const problem = messageOf(cause);
    if (!/ENOENT|ECONNREFUSED|closed the connection/.test(problem)) {
      io.err(`prefaix daemon: ${problem}\n`);
      return EXIT.agentError;
    }
  } finally {
    client.close();
  }
  // Nothing is listening, so a lock left behind is a corpse and removing it is
  // the whole of `stop` (DESIGN §8).
  if (await lockIsStale(io.paths.lock)) {
    io.out("no daemon is running\n");
    return EXIT.ok;
  }
  io.out("a daemon is running but not answering; try prefaix daemon status\n");
  return EXIT.daemonUnavailable;
}

export const daemonStatus: RunDaemon = async (_argv, io) => status(io);

export const stopDaemon: RunDaemon = async (_argv, io) => stop(io);

async function socketInfo(file: string): Promise<{ mode: number } | undefined> {
  try {
    return await stat(file);
  } catch {
    return undefined;
  }
}

export function defaultIo(env: NodeJS.ProcessEnv): CliIo {
  return {
    env,
    paths: resolvePaths(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}
