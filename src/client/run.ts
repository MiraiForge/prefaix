// `prefaix run`: the whole client (DESIGN §4.2, §4.0).
//
// The steps are: parse argv, run the grammar, connect, collect context, run the
// turn, write directives, exit. The tty is only taken for a turn, and it is
// given back on every path out of here, including the ones that throw.

import { mkdir, rename, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import {
  EXIT,
  PrefaixError,
  type ExitCode,
  messageOf,
} from "../core/errors.js";
import { loadConfig, personaSpec } from "../core/config/index.js";
import type { PrefaixConfig } from "../core/config/schema.js";
import { resolvePaths } from "../core/paths.js";
import type { PrefaixPaths } from "../core/paths.js";
import { buildContext } from "../context/shell-context.js";
import { filterEnv } from "../context/env.js";
import { parseLine, suggestions, type Parsed } from "../shells/grammar.js";
import { encodeDirectives, type Directives } from "../shells/directives.js";
import { DaemonClient } from "./connection.js";
import { TtyController, installExitGuards, type RawModeTarget } from "./tty.js";
import { Renderer } from "./render/renderer.js";
import { capabilities } from "./render/theme.js";
import type { FooterField } from "./render/chrome.js";
import type { DialogIo } from "./render/dialogs.js";
import type { DialogRequest } from "./render/dialogs.js";
import type { ShellKind, UiResponse } from "../core/agent-port.js";
import type { StatusSnapshot, TurnSummary } from "../core/protocol.js";

export interface RunArgs {
  readonly shell: ShellKind;
  readonly shellId: string;
  readonly shellVersion: string;
  readonly shellPid: number;
  readonly conversationId: string;
  readonly nonce: string;
  readonly directives: string;
  readonly cwd: string;
  /** `--recent <exit>:<command>` pairs, in the order the shell reported them. */
  readonly recent: readonly { exit: number | null; cmd: string }[];
  readonly line: string;
}

export interface RunOptions {
  readonly argv: readonly string[];
  readonly version: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly paths?: PrefaixPaths;
  readonly config?: PrefaixConfig;
  readonly out?: (text: string) => void;
  readonly err?: (text: string) => void;
  readonly stdoutIsTty?: boolean;
  readonly cols?: number;
  readonly rows?: number;
  /** The terminal, when there is one; a pty test passes its own. */
  readonly tty?: RawModeTarget;
  readonly connect?: (options: {
    paths: PrefaixPaths;
    version: string;
  }) => DaemonClient;
  readonly dialogs?: DialogIo;
  readonly sleep?: (ms: number) => Promise<void>;
}

const SHELLS: readonly ShellKind[] = ["zsh", "fish", "bash"];

export function parseRunArgs(argv: readonly string[]): RunArgs {
  const flags: Record<string, string> = {};
  const recent: { exit: number | null; cmd: string }[] = [];
  let line = "";
  let seenSeparator = false;
  for (let at = 0; at < argv.length; at++) {
    const token = argv[at] ?? "";
    if (token === "--") {
      // Everything after `--` is the raw buffer, which is why the plugin passes
      // it as one argv element: no quoting layer can mangle it.
      line = argv.slice(at + 1).join(" ");
      seenSeparator = true;
      break;
    }
    if (!token.startsWith("--")) {
      throw new PrefaixError(
        "USAGE",
        `unexpected argument ${JSON.stringify(token)}; the buffer goes after --`,
      );
    }
    const name = token.slice(2);
    if (name === "recent") {
      const value = argv[at + 1] ?? "";
      at += 1;
      const sep = value.indexOf(":");
      const exit = Number.parseInt(value.slice(0, sep), 10);
      recent.push({
        exit: Number.isInteger(exit) ? exit : null,
        cmd: sep === -1 ? value : value.slice(sep + 1),
      });
      continue;
    }
    flags[name] = argv[at + 1] ?? "";
    at += 1;
  }
  if (!seenSeparator) {
    throw new PrefaixError(
      "USAGE",
      "the buffer is required: prefaix run [flags] -- '<raw line>'",
    );
  }
  const flag = (name: string, fallback: string): string =>
    flags[name] ?? fallback;
  const shell = flag("shell", "");
  if (!(SHELLS as readonly string[]).includes(shell)) {
    throw new PrefaixError(
      "USAGE",
      `--shell must be one of: ${SHELLS.join(", ")}`,
    );
  }
  for (const required of ["shell-id", "nonce", "directives"]) {
    if ((flags[required] ?? "") === "") {
      throw new PrefaixError("USAGE", `--${required} is required`);
    }
  }
  const pid = Number.parseInt(flag("shell-pid", ""), 10);
  return {
    shell: shell as ShellKind,
    shellId: flag("shell-id", ""),
    shellVersion: flag("shell-version", "unknown"),
    shellPid: Number.isInteger(pid) && pid > 0 ? pid : process.pid,
    conversationId: flag("conversation", ""),
    nonce: flag("nonce", ""),
    directives: flag("directives", ""),
    cwd: flag("cwd", process.cwd()),
    recent,
    line,
  };
}

/**
 * The whole client. It returns an exit code rather than calling
 * `process.exit`, so every step is testable and the tty restore is observable
 * rather than assumed.
 */
export async function run(options: RunOptions): Promise<ExitCode> {
  const env = options.env ?? process.env;
  const out = options.out ?? ((text: string) => process.stdout.write(text));
  const err = options.err ?? ((text: string) => process.stderr.write(text));
  let args: RunArgs;
  try {
    args = parseRunArgs(options.argv);
  } catch (cause) {
    // Everything parseRunArgs rejects with is a usage error; there is no other
    // exit code it could mean.
    err(`${messageOf(cause)}\n`);
    return EXIT.usage;
  }

  const paths = options.paths ?? resolvePaths({ env });
  let config: PrefaixConfig;
  try {
    config = options.config ?? loadConfig({ env, file: paths.configFile });
  } catch (cause) {
    err(`${messageOf(cause)}\n`);
    if (cause instanceof PrefaixError && cause.hint !== undefined) {
      err(`${cause.hint}\n`);
    }
    return EXIT.usage;
  }

  const parsed = parseLine(args.line, {
    passthrough: config.grammar.passthrough,
    personas: Object.keys(config.personas),
  });
  if (parsed.kind === "pass") {
    // The plugin's own prefix test said this was a prefaix line and TypeScript
    // disagrees, which is a bug in one of the two. Passing it back to the shell
    // is the safe resolution: the user's command still runs.
    err(`prefaix: ${JSON.stringify(args.line)} is not a prefaix line\n`);
    return EXIT.ok;
  }

  const caps = capabilities({
    env,
    isTty: options.stdoutIsTty ?? process.stdout.isTTY === true,
    ...(options.cols === undefined ? {} : { cols: options.cols }),
    ...(options.rows === undefined ? {} : { rows: options.rows }),
  });

  // The renderer answers a dialog through the daemon, which needs the turn id.
  // It is a local rather than module state so two runs in one process (a test,
  // or a `:help` before a turn) cannot answer for each other.
  let turnId: string | undefined;
  const renderer = new Renderer({
    caps,
    out,
    err,
    footer: footerFields(config),
    answer: (request, response) => {
      if (turnId !== undefined) {
        void client
          .respondUi(turnId, request.id, response)
          .catch(() => undefined);
      }
    },
    ...(options.dialogs === undefined ? {} : { dialogs: options.dialogs }),
  });

  const configFile = paths.configFile;
  const connect =
    options.connect ??
    ((clientOptions) =>
      new DaemonClient({
        paths: clientOptions.paths,
        version: clientOptions.version,
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      }));
  const client = connect({ paths, version: options.version });

  const directives: Directives = { nonce: args.nonce };
  // Assigned on every branch below; declared without a value so the compiler
  // insists each path sets it.
  let exit: ExitCode;
  let tty: TtyController | undefined;
  let releaseGuards: (() => void) | undefined;

  try {
    await client.connect();

    if (parsed.kind === "command") {
      exit = await runCommand(
        parsed,
        client,
        renderer,
        args,
        env,
        err,
        configFile,
      );
      if (exit === EXIT.ok && parsed.class === "run") {
        directives.conversation = args.conversationId;
      }
    } else if (parsed.kind === "agent") {
      // A slash command is the agent's own; prefaix sends it as a prompt and
      // lets the backend expand it (DESIGN §4.5.5).
      const controller = new AbortController();
      tty = startTty(options, controller, renderer);
      releaseGuards = installExitGuards(() => tty?.restore());
      tty.enter();
      renderer.begin();
      const result = await runTurn({
        client,
        renderer,
        config,
        args,
        env,
        text: `/${parsed.name} ${parsed.args}`.trim(),
        controller,
        setTurnId: (id) => {
          turnId = id;
        },
      });
      exit = result.exit;
      directives.conversation = result.conversationId;
      directives.buffer = bufferFrom(renderer, tty);
    } else {
      const persona =
        parsed.persona === undefined
          ? undefined
          : personaSpec(config, parsed.persona);
      if (parsed.persona !== undefined && persona === undefined) {
        // A persona the config does not define is a usage error, not a turn the
        // agent will refuse: nothing has been sent yet.
        err(`unknown persona ${JSON.stringify(parsed.persona)}\n`);
        exit = EXIT.usage;
      } else {
        const controller = new AbortController();
        tty = startTty(options, controller, renderer);
        releaseGuards = installExitGuards(() => tty?.restore());
        tty.enter();
        renderer.begin();
        const result = await runTurn({
          client,
          renderer,
          config,
          args,
          env,
          text: parsed.text,
          controller,
          setTurnId: (id) => {
            turnId = id;
          },
          ...(persona === undefined ? {} : { persona: persona.name }),
        });
        exit = result.exit;
        directives.conversation = result.conversationId;
        const buffer = bufferFrom(renderer, tty);
        if (buffer !== "") {
          directives.buffer = buffer;
        }
      }
    }
  } catch (cause) {
    exit = cause instanceof PrefaixError ? cause.exitCode : EXIT.agentError;
    err(`${messageOf(cause)}\n`);
    if (cause instanceof PrefaixError && cause.hint !== undefined) {
      err(`${cause.hint}\n`);
    }
  } finally {
    releaseGuards?.();
    tty?.restore();
    client.close();
  }

  await writeDirectives(args.directives, directives);
  return exit;
}

function footerFields(config: PrefaixConfig): FooterField[] {
  return config.ui.footer.filter(
    (field): field is FooterField =>
      field === "time" ||
      field === "tools" ||
      field === "cost" ||
      field === "context" ||
      field === "model",
  );
}

function bufferFrom(
  renderer: Renderer,
  tty: TtyController | undefined,
): string {
  const fromAgent = renderer.takeBuffer();
  if (fromAgent !== "") {
    return fromAgent;
  }
  // Typeahead is the user's own half-typed line, and it belongs in the prompt
  // they will see next, not in the stream they just scrolled past.
  return tty?.takeCaptured() ?? "";
}

function startTty(
  options: RunOptions,
  controller: AbortController,
  renderer: Renderer,
): TtyController {
  const tty = new TtyController({
    ...(options.tty === undefined ? {} : { input: options.tty }),
    onKey: (key) => {
      if (
        key.name === "esc" ||
        key.name === "ctrl-c" ||
        key.name === "ctrl-d"
      ) {
        controller.abort();
        renderer.notice("aborting…");
        return;
      }
      tty.capture(key.text);
    },
    onEsc: () => {
      controller.abort();
      renderer.notice("aborting…");
    },
  });
  return tty;
}

interface TurnOptions {
  readonly client: DaemonClient;
  readonly renderer: Renderer;
  readonly config: PrefaixConfig;
  readonly args: RunArgs;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly text: string;
  readonly persona?: string;
  readonly controller: AbortController;
  readonly setTurnId: (turnId: string) => void;
}

interface TurnRun {
  readonly exit: ExitCode;
  readonly conversationId: string;
}

async function runTurn(options: TurnOptions): Promise<TurnRun> {
  const { client, renderer, config, args, env } = options;
  const built = buildContext(
    {
      env,
      shell: {
        kind: args.shell,
        version: args.shellVersion,
        shellId: args.shellId,
        pid: args.shellPid,
      },
      cwd: args.cwd,
      recent: args.recent,
      contextLimit: config.context.recentCommands,
      includeExitCodes: config.context.includeExitCodes,
      redact: config.context.redact,
      ...(config.context.extraRedactPatterns.length === 0
        ? {}
        : { extraRedactPatterns: config.context.extraRedactPatterns }),
    },
    config.env,
  );

  const ended = new Promise<TurnSummary>((resolve) => {
    client.onTurnEnd((_turnId, summary) => resolve(summary));
  });
  client.onEvent((_turnId, { event }) => {
    renderer.handle(event);
  });

  const started = await client.call<{ turnId: string; conversationId: string }>(
    "turn.start",
    {
      ...(args.conversationId === ""
        ? {}
        : { conversationId: args.conversationId }),
      shell: built.context.shell,
      cwd: built.context.cwd,
      env: built.agentEnv,
      text: options.text,
      ...(options.persona === undefined ? {} : { persona: options.persona }),
      context: {
        recent: built.context.recent,
        os: built.context.os,
        term: built.context.term,
      },
    },
  );
  options.setTurnId(started.turnId);

  // Esc aborts locally and tells the daemon, so the turn ends even if the client
  // dies on the way out.
  const onAbort = (): void => {
    void client
      .call("turn.abort", { turnId: started.turnId })
      .catch(() => undefined);
  };
  options.controller.signal.addEventListener("abort", onAbort, { once: true });

  const summary = await ended;
  options.controller.signal.removeEventListener("abort", onAbort);
  return {
    conversationId: started.conversationId,
    exit: exitForSummary(summary),
  };
}

function exitForSummary(summary: TurnSummary): ExitCode {
  switch (summary.status) {
    case "stop":
    case "length":
      return EXIT.ok;
    case "aborted":
      return EXIT.aborted;
    case "error":
      return EXIT.agentError;
  }
}

/** The commands this milestone can carry out. */
async function runCommand(
  parsed: Extract<Parsed, { kind: "command" }>,
  client: DaemonClient,
  renderer: Renderer,
  args: RunArgs,
  env: Readonly<Record<string, string | undefined>>,
  err: (text: string) => void,
  configFile: string,
): Promise<ExitCode> {
  if (parsed.summary === "unknown command") {
    // A name prefaix has never heard of, and the grammar only gets here when
    // something close exists, so the suggestion is always worth giving.
    err(
      `prefaix: :${parsed.name} is not a command. Did you mean ${suggestions(
        parsed.name,
      )
        .map((name) => `:${name}`)
        .join(", ")}?\n`,
    );
    return EXIT.usage;
  }
  if (!parsed.known) {
    // A real command that belongs to a later milestone. Saying it is not in
    // this build is honest; pretending it does not exist is not.
    err(
      `prefaix: :${parsed.name} arrives in the ${parsed.milestone} milestone, not this one.\n`,
    );
    return EXIT.usage;
  }
  switch (parsed.name) {
    case "new":
    case "n":
      return runNew(parsed.args, client, renderer, args, env, configFile);
    case "info":
    case "i":
      return runInfo(client, renderer, args);
    case "help":
    case "?":
      runHelp(renderer);
      return EXIT.ok;
    default:
      err(`prefaix: :${parsed.name} is not available in this build yet.\n`);
      return EXIT.usage;
  }
}

/**
 * `:new` creates the conversation and, when text follows, prompts it at once.
 * The new id goes back to the shell as a directive, which is what makes the
 * next `:` continue the new conversation rather than the old one.
 */
async function runNew(
  text: string,
  client: DaemonClient,
  renderer: Renderer,
  args: RunArgs,
  env: Readonly<Record<string, string | undefined>>,
  configFile: string,
): Promise<ExitCode> {
  const created = await client.call<{ id: string; title: string }>("conv.new", {
    shell: {
      kind: args.shell,
      version: args.shellVersion,
      shellId: args.shellId,
      pid: args.shellPid,
    },
    cwd: args.cwd,
    env: filterEnv(env, { passthrough: "all", allowlist: null, deny: [] }),
  });
  if (text === "") {
    renderer.notice(`new conversation: ${created.title}`);
    return EXIT.ok;
  }
  const result = await runTurn({
    client,
    renderer,
    config: loadConfig({ env, file: configFile }),
    args: { ...args, conversationId: created.id },
    env,
    text,
    controller: new AbortController(),
    setTurnId: () => undefined,
  });
  return result.exit;
}

async function runInfo(
  client: DaemonClient,
  renderer: Renderer,
  args: RunArgs,
): Promise<ExitCode> {
  const status = await client.call<StatusSnapshot>("status.get", {
    ...(args.conversationId === ""
      ? {}
      : { conversationId: args.conversationId }),
  });
  const conversation = status.conversation;
  renderer.line(
    conversation === undefined
      ? "conversation: none yet"
      : `conversation: ${conversation.title} (${conversation.id}) · ${String(conversation.turns)} turns`,
  );
  if (conversation !== undefined) {
    renderer.line(`root: ${conversation.root}`);
  }
  renderer.line(`backend: ${status.backend}`);
  renderer.line(`model: ${modelLabel(status.model)}`);
  if (status.thinking !== undefined) {
    renderer.line(`thinking: ${status.thinking}`);
  }
  if (status.usage?.costUsd !== undefined) {
    renderer.line(`cost: $${status.usage.costUsd.toFixed(3)}`);
  }
  if (typeof status.contextPct === "number") {
    renderer.line(`context: ${status.contextPct.toFixed(0)}%`);
  }
  renderer.line(
    `daemon: pid ${String(status.pid)} · prefaix ${status.version}`,
  );
  return EXIT.ok;
}

function modelLabel(
  model: { provider: string; id: string } | undefined,
): string {
  // No model in the snapshot means the conversation is still on whatever the
  // backend was configured with, which is not the same as having no model.
  return model === undefined ? "pi's default" : `${model.provider}/${model.id}`;
}

function runHelp(renderer: Renderer): void {
  for (const line of HELP_LINES) {
    renderer.line(line);
  }
}

const HELP_LINES: readonly string[] = [
  "prefaix line grammar:",
  "  : <text>            prompt the active conversation",
  "  :<command> [args]   a prefaix command",
  "  :/<name> [args]     an agent command",
  "  : <text>            pass through to the shell",
  "  \\: <text>           pass through to the shell",
  "",
  "commands:",
  "  :new [text]         start a new conversation",
  "  :conversation [q]   switch conversation (:c - for the last one)",
  "  :model [q]          pick or set the model",
  "  :think <level>      set the thinking level",
  "  :info               what this conversation is doing",
  "  :copy               copy the last answer",
  "  :help               this text",
  "  :doctor             check the backend, shell, socket, and config",
  "",
  "esc or ctrl+c aborts a turn; anything you type during one comes back here.",
];

/**
 * Writes the directives file the plugin reads after the turn. It is written
 * atomically because the plugin may read it the moment `prefaix run` exits, and
 * a half-written file would be read as a missing nonce and silently ignored.
 */
export async function writeDirectives(
  target: string,
  directives: Directives,
): Promise<void> {
  if (target === "" || directives.nonce === "") {
    return;
  }
  const temp = `${target}.${String(process.pid)}.tmp`;
  await mkdir(posix.dirname(target), { recursive: true, mode: 0o700 }).catch(
    () => undefined,
  );
  await writeFile(temp, encodeDirectives(directives), { mode: 0o600 });
  await rename(temp, target);
}

export type { DialogRequest, UiResponse };
