import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { createBackend } from "../agents/registry.js";
import type {
  AgentBackend,
  ProbeResult,
  ShellKind,
} from "../core/agent-port.js";
import {
  defaultConfig,
  resolveConfig,
  type PrefaixConfig,
} from "../core/config/index.js";
import { EXIT, type ExitCode } from "../core/errors.js";
import { resolvePaths, type PrefaixPaths } from "../core/paths.js";
import { detectShell, shellRcFile, type SetupEnv } from "./setup.js";

export const MIN_PI_VERSION = "0.87.1";
export interface DoctorCheck {
  readonly id: string;
  readonly status: "ok" | "warn" | "error";
  readonly message: string;
  readonly fix?: string;
}
export interface DoctorOptions {
  readonly env?: SetupEnv;
  readonly home?: string;
  readonly paths?: PrefaixPaths;
  readonly out?: (text: string) => void;
  readonly err?: (text: string) => void;
  readonly shell?: ShellKind;
  readonly shellVersion?: string;
  readonly pluginLoaded?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly backend?: AgentBackend;
  readonly command?: (
    bin: string,
    args: readonly string[],
    env: SetupEnv,
  ) => Promise<string | undefined>;
}

function versionTuple(value: string | undefined): number[] | undefined {
  const match = value?.match(/(?:^|\s|v)(\d+)\.(\d+)(?:\.(\d+))?(?=\b|$)/);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
    : undefined;
}
function atLeast(version: number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < minimum.length; i++) {
    const actual = version[i] ?? 0;
    const required = minimum[i] ?? 0;
    if (actual !== required) return actual > required;
  }
  return true;
}
async function commandVersion(
  bin: string,
  args: readonly string[],
  env: SetupEnv,
): Promise<string | undefined> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      { env: { ...env }, timeout: 3_000, maxBuffer: 16_384 },
      (error, stdout) => {
        resolve(error ? undefined : stdout);
      },
    );
  });
}
function executable(bin: string, env: SetupEnv): boolean {
  const candidates = (env["PATH"] ?? "")
    .split(delimiter)
    .filter((part) => part !== "")
    .map((part) => join(part, bin));
  return candidates.some((file) => {
    try {
      accessSync(file, constants.X_OK);
      return lstatSync(file).isFile() || lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  });
}
function readOptional(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw cause;
  }
}
function checkPath(
  id: "runtime" | "socket",
  file: string,
  uid: number,
): DoctorCheck {
  const name = id === "runtime" ? "Runtime directory" : "Daemon socket";
  try {
    const stat = lstatSync(file);
    const expected = id === "runtime" ? 0o700 : 0o600;
    if (
      stat.uid !== uid ||
      (stat.mode & 0o777) !== expected ||
      !(id === "runtime" ? stat.isDirectory() : stat.isSocket())
    ) {
      return {
        id,
        status: "error",
        message: `${name} has unsafe ownership, type, or permissions.`,
        fix: `Stop the daemon; restore your ownership and mode ${id === "runtime" ? "0700 on its runtime directory" : "0600 on its socket"}. Do not use a symlink.`,
      };
    }
    return {
      id,
      status: "ok",
      message: `${name} is private and owned by you.`,
    };
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? {
          id,
          status: "ok",
          message: `${name} is absent; the daemon will create it securely when needed.`,
        }
      : {
          id,
          status: "error",
          message: `${name} cannot be inspected.`,
          fix: "Check directory access permissions, then rerun prefaix doctor.",
        };
  }
}

async function piChecks(
  backend: AgentBackend,
  env: SetupEnv,
  home: string,
): Promise<DoctorCheck[]> {
  let probe: ProbeResult;
  try {
    probe = await backend.probe();
  } catch {
    probe = { installed: false, usable: false };
  }
  if (!probe.installed) {
    return [
      {
        id: "pi",
        status: "error",
        message: "pi was not found or could not be inspected.",
        fix: "Install @earendil-works/pi-coding-agent and put pi on PATH, or set agent.pi.bin.",
      },
    ];
  }
  const checks: DoctorCheck[] = [
    { id: "pi", status: "ok", message: "pi is installed." },
  ];
  const version = versionTuple(probe.version);
  const supported = version !== undefined && atLeast(version, [0, 87, 1]);
  checks.push(
    supported
      ? {
          id: "pi-version",
          status: "ok",
          message: `pi meets the tested minimum (${MIN_PI_VERSION}).`,
        }
      : {
          id: "pi-version",
          status: "error",
          message: "pi version is unknown or older than the tested minimum.",
          fix: `Install pi ${MIN_PI_VERSION} or newer, then rerun prefaix doctor.`,
        },
  );
  if (!supported || !probe.usable) {
    checks.push({
      id: "pi-rpc",
      status: "error",
      message:
        "pi RPC probe was skipped because the installation is not usable.",
      fix: "Repair or upgrade pi, then rerun prefaix doctor.",
    });
    return checks;
  }
  try {
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env))
      if (value !== undefined) childEnv[key] = value;
    const session = await backend.open({ root: home, env: childEnv });
    try {
      await session.state();
      await session.listModels();
      await session.listCommands?.();
      await session.abort();
    } finally {
      await session.close();
    }
    checks.push({
      id: "pi-rpc",
      status: "ok",
      message:
        "pi RPC handshake, state, models, commands, idle abort, and shutdown passed without a model request.",
    });
  } catch {
    checks.push({
      id: "pi-rpc",
      status: "error",
      message: "pi RPC handshake or no-model probe failed.",
      fix: "Check that pi starts in RPC mode; update or repair pi and rerun prefaix doctor.",
    });
  }
  return checks;
}

/** Returns only fixed diagnostic text, never config values, child output, or environment values. */
export async function collectDoctorChecks(
  options: DoctorOptions = {},
): Promise<readonly DoctorCheck[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? env["HOME"] ?? homedir();
  const checks: DoctorCheck[] = [];
  let paths: PrefaixPaths;
  try {
    paths = options.paths ?? resolvePaths({ env, home });
  } catch {
    return [
      {
        id: "paths",
        status: "error",
        message: "The runtime layout cannot be resolved.",
        fix: "Use absolute HOME and XDG directory paths, then rerun prefaix doctor.",
      },
    ];
  }
  let config: PrefaixConfig = defaultConfig();
  try {
    const resolved = resolveConfig({
      text: readOptional(paths.configFile),
      env,
      home,
    });
    if (resolved.diagnostics.length > 0) {
      checks.push({
        id: "config",
        status: "error",
        message: "Configuration or PREFAIX overrides are invalid.",
        fix: "Review config.toml and PREFAIX overrides against the configuration reference. Values are omitted for privacy.",
      });
    } else {
      config = resolved.config;
      checks.push({
        id: "config",
        status: "ok",
        message: "Configuration and PREFAIX overrides are valid.",
      });
    }
  } catch {
    checks.push({
      id: "config",
      status: "error",
      message: "Configuration could not be read.",
      fix: "Check config.toml access permissions and file type.",
    });
  }
  const backend =
    options.backend ??
    createBackend("pi", {
      pi: {
        bin: config.agent.pi.bin,
        env,
        requestTimeoutMs: 3_000,
        readyTimeoutMs: 5_000,
        // No sessions are persisted and user extensions are disabled: this probe has no prompt path.
        rpc: {
          args: [
            "--mode",
            "rpc",
            "--no-session",
            "--no-extensions",
            "--no-skills",
          ],
        },
      },
    });
  checks.push(...(await piChecks(backend, env, home)));
  const shell = options.shell ?? detectShell(env);
  if (shell === undefined) {
    checks.push({
      id: "shell",
      status: "error",
      message: "The invoking shell could not be identified.",
      fix: "Run doctor from zsh, fish, or bash after loading prefaix init.",
    });
  } else {
    const shellBin =
      basename(env["SHELL"] ?? "") === shell ? env["SHELL"]! : shell;
    const reportedVersion =
      env["PREFAIX_PLUGIN_LOADED"] === "1"
        ? env["PREFAIX_SHELL_VERSION"]
        : undefined;
    const output =
      options.shellVersion ??
      reportedVersion ??
      (await (options.command ?? commandVersion)(
        shellBin,
        ["--version"],
        env,
      ).catch(() => undefined));
    const version = versionTuple(output);
    const minimum =
      shell === "zsh" ? [5, 8] : shell === "fish" ? [3, 6] : [4, 4];
    checks.push(
      version !== undefined && atLeast(version, minimum)
        ? {
            id: "shell",
            status: "ok",
            message: `${shell} meets the supported version requirement.`,
          }
        : shell === "bash" && version !== undefined && atLeast(version, [3, 2])
          ? {
              id: "shell",
              status: "warn",
              message:
                "bash supports only the degraded pfx command on this version.",
              fix: "Install bash 4.4 or newer for colon interception.",
            }
          : {
              id: "shell",
              status: "error",
              message: `${shell} version is unavailable or unsupported.`,
              fix: `Install ${shell} ${minimum.join(".")} or newer.`,
            },
    );
  }
  const loaded = options.pluginLoaded ?? env["PREFAIX_PLUGIN_LOADED"] === "1";
  checks.push(
    loaded
      ? {
          id: "plugin",
          status: "ok",
          message: "The prefaix shell plugin is loaded.",
        }
      : {
          id: "plugin",
          status: "warn",
          message: "The prefaix shell plugin is not loaded in this shell.",
          fix: "Run prefaix setup, then restart the shell.",
        },
  );
  let rc = "";
  try {
    if (shell !== undefined) rc = readOptional(shellRcFile(shell, home, env));
  } catch {
    checks.push({
      id: "rc",
      status: "warn",
      message: "The shell rc file could not be inspected for conflicts.",
      fix: "Check rc-file access permissions and remove conflicting Forge or ble.sh initialization.",
    });
  }
  const activeRc = rc
    .split("\n")
    .map((line) => line.replace(/#.*/, ""))
    .join("\n");
  const forge =
    env["PREFAIX_FORGE_CONFLICT"] === "1" ||
    /(?:forge\s+(?:init|(?:zsh|bash|fish)\s+plugin)|(?:pi-zsh-plugin|forge(?:\.plugin)?\.(?:zsh|bash|fish))|plugins\s*=\([^)]*\bforge\b)/i.test(
      activeRc,
    );
  const ble =
    env["PREFAIX_BLE_CONFLICT"] === "1" ||
    /(?:^|[\s/])ble\.sh\b/.test(activeRc);
  checks.push(
    forge
      ? {
          id: "forge",
          status: "error",
          message: "A Forge shell plugin may conflict with prefaix.",
          fix: "Remove Forge initialization from the shell rc file, then restart the shell.",
        }
      : {
          id: "forge",
          status: "ok",
          message: "No Forge plugin conflict detected.",
        },
  );
  checks.push(
    ble
      ? {
          id: "ble",
          status: "error",
          message: "ble.sh may conflict with prefaix's bash bindings.",
          fix: "Disable ble.sh in the prefaix shell, then restart it.",
        }
      : { id: "ble", status: "ok", message: "No ble.sh conflict detected." },
  );
  const uid = options.uid ?? process.getuid?.() ?? -1;
  checks.push(
    checkPath("runtime", paths.runtimeDir, uid),
    checkPath("socket", paths.socket, uid),
  );
  const tools =
    (options.platform ?? process.platform) === "darwin"
      ? ["pbcopy"]
      : [
          ...(env["WAYLAND_DISPLAY"] ? ["wl-copy"] : []),
          ...(env["DISPLAY"] ? ["xclip"] : []),
        ];
  checks.push(
    tools.some((bin) => executable(bin, env))
      ? {
          id: "clipboard",
          status: "ok",
          message: "A clipboard tool is available.",
        }
      : {
          id: "clipboard",
          status: "warn",
          message: "No clipboard tool is available for this display.",
          fix: "Use pbcopy on macOS, wl-copy on Wayland, or xclip on X11.",
        },
  );
  return checks;
}
export function formatDoctorChecks(checks: readonly DoctorCheck[]): string {
  return (
    checks
      .map(
        (check) =>
          `${check.status === "ok" ? "✓" : check.status === "warn" ? "⚠" : "✗"} ${check.message}${check.fix === undefined ? "" : `\n  Fix: ${check.fix}`}`,
      )
      .join("\n") + "\n"
  );
}
export async function runDoctor(
  options: DoctorOptions = {},
): Promise<ExitCode> {
  const checks = await collectDoctorChecks(options);
  (
    options.out ??
    ((text: string) => {
      process.stdout.write(text);
    })
  )(formatDoctorChecks(checks));
  return checks.some((check) => check.status === "error")
    ? EXIT.agentError
    : EXIT.ok;
}
