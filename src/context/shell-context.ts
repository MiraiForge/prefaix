// The shell context the model is told about each turn (DESIGN §7.1, §7.2).
//
// This is the boundary where the client's knowledge of the user's session
// becomes data for the agent: the cwd, the terminal, and a redacted list of
// recent commands. Nothing else crosses. Command *output* is not sent, env
// secrets are never included, and the redactor runs here rather than in the
// renderer, so a future renderer cannot forget it.

import { platform, release } from "node:os";
import type {
  ColorDepth,
  ShellContext,
  ShellKind,
  TerminalInfo,
} from "../core/agent-port.js";
import { filterEnv, type EnvPolicy } from "./env.js";
import { Redactor } from "./redaction.js";

export interface TerminalProbe {
  readonly cols: number;
  readonly rows: number;
  readonly isTty: boolean;
  readonly colors: ColorDepth;
  readonly program?: string;
}

/** What the terminal said about itself, from environment variables only. */
export function readTerminal(
  env: Readonly<Record<string, string | undefined>>,
): TerminalProbe {
  const term = env["TERM"] ?? "";
  const colorterm = env["COLORTERM"] ?? "";
  const isTty = term !== "" && term !== "dumb";
  const colors: ColorDepth = !isTty
    ? 0
    : colorterm === "truecolor" || colorterm === "24bit"
      ? 16_777_216
      : /-256(color)?$/u.test(term) || /-direct$/u.test(term)
        ? 256
        : 16;
  const cols = Number.parseInt(env["COLUMNS"] ?? "", 10);
  const rows = Number.parseInt(env["LINES"] ?? "", 10);
  return {
    cols: Number.isInteger(cols) && cols > 0 ? cols : 80,
    rows: Number.isInteger(rows) && rows > 0 ? rows : 24,
    isTty,
    colors,
    ...(env["TERM_PROGRAM"] === undefined
      ? {}
      : { program: env["TERM_PROGRAM"] }),
  };
}

export interface ContextOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly shell: {
    kind: ShellKind;
    version: string;
    shellId: string;
    pid: number;
  };
  readonly cwd: string;
  readonly recent: readonly { cmd: string; exit: number | null }[];
  readonly contextLimit: number;
  readonly includeExitCodes: boolean;
  readonly redact: boolean;
  readonly extraRedactPatterns?: readonly string[];
}

export interface BuiltContext {
  readonly context: ShellContext;
  /** The environment the agent child will be given. */
  readonly agentEnv: Record<string, string>;
  readonly term: TerminalInfo;
}

export function osName(): string {
  return `${platform()} ${release()}`;
}

/**
 * Builds the turn's context. Recent commands are trimmed to the configured
 * count *before* redaction so the limit is about what the model sees, and
 * redacted after, because a limit on the unredacted list would be a limit on
 * secrets rather than on noise.
 */
export function buildContext(
  options: ContextOptions,
  policy: EnvPolicy,
): BuiltContext {
  const term = readTerminal(options.env);
  const redactor = new Redactor({
    enabled: options.redact,
    ...(options.extraRedactPatterns === undefined
      ? {}
      : { patterns: options.extraRedactPatterns }),
  });
  const recent = options.recent
    .slice(-Math.max(0, options.contextLimit))
    .map((entry) => ({
      cmd: redactor.redact(entry.cmd),
      exit: options.includeExitCodes ? entry.exit : null,
    }));
  return {
    context: {
      shell: options.shell,
      cwd: options.cwd,
      recent,
      os: osName(),
      term: {
        cols: term.cols,
        rows: term.rows,
        colors: term.colors,
        ...(term.program === undefined ? {} : { program: term.program }),
      },
    },
    agentEnv: filterEnv(options.env, policy),
    term: {
      cols: term.cols,
      rows: term.rows,
      colors: term.colors,
      ...(term.program === undefined ? {} : { program: term.program }),
    },
  };
}
