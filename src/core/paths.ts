import { homedir } from "node:os";
import { posix } from "node:path";
import { PrefaixError } from "./errors.js";
import { isConversationId, isShellId } from "./ids.js";

// Filesystem layout from DESIGN §5 and §4.3.1. Resolution is pure: callers
// create directories and enforce the 0700/0600 modes and owner checks.

const SOCKET_NAME = "daemon.sock";

// sizeof(sockaddr_un.sun_path), including the terminating NUL.
const SUN_PATH_BYTES: Partial<Record<NodeJS.Platform, number>> = {
  darwin: 104,
  linux: 108,
};
const DEFAULT_SUN_PATH_BYTES = 104;

export function fitsSunPath(path: string, platform: NodeJS.Platform): boolean {
  const limit = SUN_PATH_BYTES[platform] ?? DEFAULT_SUN_PATH_BYTES;
  return Buffer.byteLength(path) < limit;
}

export interface PathOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  uid?: number;
  platform?: NodeJS.Platform;
}

export interface PrefaixPaths {
  configDir: string;
  configFile: string;
  stateDir: string;
  conversationsDir: string;
  shellHintsDir: string;
  logsDir: string;
  daemonLog: string;
  runtimeDir: string;
  // True when the preferred socket path exceeded sun_path and the runtime dir
  // moved to the shared /tmp, where ownership checks matter most.
  runtimeFallback: boolean;
  socket: string;
  lock: string;
  shellsDir: string;
  turnsDir: string;
  cacheDir: string;
}

export function resolvePaths(options: PathOptions = {}): PrefaixPaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const fromHome = (relative: string) => {
    const home = options.home ?? homedir();
    if (!posix.isAbsolute(home)) {
      throw new PrefaixError(
        "USAGE",
        `Home directory is not an absolute path: ${JSON.stringify(home)}`,
        { hint: "Set HOME or the XDG_*_HOME variables to absolute paths." },
      );
    }
    return posix.join(home, relative);
  };

  // XDG Base Directory spec: unset, empty, or relative values are ignored.
  const xdg = (name: string) => {
    const value = env[name];
    return value && posix.isAbsolute(value)
      ? posix.join(value, "prefaix")
      : undefined;
  };

  const configDir = xdg("XDG_CONFIG_HOME") ?? fromHome(".config/prefaix");
  const stateDir = xdg("XDG_STATE_HOME") ?? fromHome(".local/state/prefaix");
  const cacheDir = xdg("XDG_CACHE_HOME") ?? fromHome(".cache/prefaix");
  const preferredRuntime =
    xdg("XDG_RUNTIME_DIR") ?? posix.join(stateDir, "run");

  const runtimeFallback = !fitsSunPath(
    posix.join(preferredRuntime, SOCKET_NAME),
    platform,
  );
  const runtimeDir = runtimeFallback
    ? `/tmp/prefaix-${options.uid ?? process.getuid?.() ?? -1}`
    : preferredRuntime;

  return {
    configDir,
    configFile: posix.join(configDir, "config.toml"),
    stateDir,
    conversationsDir: posix.join(stateDir, "conversations"),
    shellHintsDir: posix.join(stateDir, "shells"),
    logsDir: posix.join(stateDir, "logs"),
    daemonLog: posix.join(stateDir, "logs", "daemon.log"),
    runtimeDir,
    runtimeFallback,
    socket: posix.join(runtimeDir, SOCKET_NAME),
    lock: posix.join(runtimeDir, "daemon.lock"),
    shellsDir: posix.join(runtimeDir, "shells"),
    turnsDir: posix.join(runtimeDir, "turns"),
    cacheDir,
  };
}

export function conversationFile(paths: PrefaixPaths, id: string): string {
  if (!isConversationId(id)) {
    throw new PrefaixError(
      "USAGE",
      `Invalid conversation id: ${JSON.stringify(id)}`,
    );
  }
  return posix.join(paths.conversationsDir, `${id}.json`);
}

function checkShellId(shellId: string): void {
  if (!isShellId(shellId)) {
    throw new PrefaixError(
      "USAGE",
      `Invalid shell id: ${JSON.stringify(shellId)}`,
    );
  }
}

// Per-shell hints such as the previous conversation for `:c -` (§4.3.5).
export function shellHintsFile(paths: PrefaixPaths, shellId: string): string {
  checkShellId(shellId);
  return posix.join(paths.shellHintsDir, `${shellId}.json`);
}

// Files the shell plugin reads with builtins after a turn (§4.1.0).
export function shellRuntimeFiles(
  paths: PrefaixPaths,
  shellId: string,
): { dir: string; directives: string; status: string } {
  checkShellId(shellId);
  const dir = posix.join(paths.shellsDir, shellId);
  return {
    dir,
    directives: posix.join(dir, "directives"),
    status: posix.join(dir, "status"),
  };
}
