// `prefaix run`: the whole client (DESIGN §4.2, §4.0).
//
// The steps are: parse argv, run the grammar, connect, collect context, run the
// turn, write directives, exit. The tty is only taken for a turn, and it is
// given back on every path out of here, including the ones that throw.

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
import { writeShellStatus } from "../core/status-file.js";
import { buildContext } from "../context/shell-context.js";
import { filterEnv } from "../context/env.js";
import {
  parseLine,
  suggestions,
  COMMAND_NAMES,
  COMMANDS,
  type Parsed,
} from "../shells/grammar.js";
import { encodeDirectives, type Directives } from "../shells/directives.js";
import { DaemonClient } from "./connection.js";
import { TtyController, installExitGuards, type RawModeTarget } from "./tty.js";
import { Renderer } from "./render/renderer.js";
import { capabilities } from "./render/theme.js";
import type { FooterField } from "./render/chrome.js";
import type { DialogIo } from "./render/dialogs.js";
import type { DialogRequest } from "./render/dialogs.js";
import type {
  AgentCommand,
  ShellKind,
  UiResponse,
} from "../core/agent-port.js";
import { PLAN_EXECUTION_PROMPT } from "../core/protocol.js";
import type {
  ConversationSummary,
  ModelListResult,
  StatusSnapshot,
  TurnSummary,
} from "../core/protocol.js";
import type { PickItem } from "./picker.js";
import { copyText } from "./clipboard.js";
import { plain } from "./process.js";
import {
  cacheCommands,
  cachedCommands,
  commandAlias,
  commandPrompt,
} from "./agent-commands.js";

export interface RunArgs {
  readonly shell: ShellKind;
  readonly shellId: string;
  readonly shellVersion: string;
  readonly shellPid: number;
  readonly conversationId: string;
  readonly previousConversationId: string;
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
  readonly doctor?: (args: RunArgs) => Promise<ExitCode>;
  readonly picker?: (
    items: readonly PickItem[],
    title: string,
  ) => Promise<string | undefined>;
  readonly clipboard?: (text: string) => Promise<void>;
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
    previousConversationId: flag("previous-conversation", ""),
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
  const local = parseLine(args.line);
  if (
    local.kind === "command" &&
    local.args.trim() !== "" &&
    COMMANDS.some(
      (command) =>
        !command.takesArgs &&
        (command.name === local.name || command.aliases.includes(local.name)),
    )
  ) {
    err(
      `prefaix: :${local.name} does not take arguments. Use ': <text>' to send a prompt.\n`,
    );
    await writeDirectives(args.directives, { nonce: args.nonce });
    return EXIT.usage;
  }
  if (
    local.kind === "command" &&
    ["help", "?", "doctor"].includes(local.name)
  ) {
    const exit =
      local.name === "doctor"
        ? await (options.doctor?.(args) ?? Promise.resolve(EXIT.usage))
        : (HELP_LINES.forEach((line) => out(`${line}\n`)), EXIT.ok);
    if (local.name !== "doctor") {
      const commands = await cachedCommands(paths, args.conversationId);
      if (commands.length > 0) {
        out("\nagent commands (cached for this conversation):\n");
        for (const command of commands)
          out(
            `  :${commandAlias(command)}${command.description === undefined ? "" : ` — ${plain(command.description)}`}\n`,
          );
      } else
        out(
          "\nAgent commands: use :/<name> [args]; run a turn to cache this conversation's available commands.\n",
        );
    }
    if (local.name === "doctor" && options.doctor === undefined)
      err("prefaix: doctor is unavailable in this client host\n");
    await writeDirectives(args.directives, { nonce: args.nonce });
    return exit;
  }

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

    let text: string | undefined;
    let persona: string | undefined;
    let executePlan: boolean | undefined;
    let conversationId = args.conversationId;
    exit = EXIT.ok;
    if (parsed.kind === "command") {
      const result = await runCommand(
        parsed,
        client,
        renderer,
        args,
        env,
        err,
        config,
        options,
      );
      exit = result.exit;
      conversationId = result.conversationId ?? conversationId;
      if (conversationId !== "") directives.conversation = conversationId;
      text = result.text;
      executePlan = result.executePlan;
    } else if (parsed.kind === "agent") {
      text = `/${parsed.name} ${parsed.args}`.trim();
    } else {
      if (
        parsed.persona !== undefined &&
        personaSpec(config, parsed.persona) === undefined
      ) {
        throw new PrefaixError(
          "USAGE",
          `unknown persona ${JSON.stringify(parsed.persona)}`,
          {
            hint: `Known personas: ${Object.keys(config.personas).join(", ")}`,
          },
        );
      }
      persona = parsed.persona;
      text = parsed.text;
    }
    if (text !== undefined) {
      const controller = new AbortController();
      tty = startTty(options, controller, renderer);
      releaseGuards = installExitGuards(() => tty?.restore());
      tty.enter();
      renderer.begin();
      const result = await runTurn({
        client,
        renderer,
        config,
        args: { ...args, conversationId },
        env,
        text,
        controller,
        setTurnId: (id) => {
          turnId = id;
        },
        setConversationId: (id) => {
          directives.conversation = id;
        },
        ...(persona === undefined ? {} : { persona }),
        ...(executePlan === undefined ? {} : { executePlan }),
      });
      exit = result.exit;
      conversationId = result.conversationId;
    }
    if (conversationId !== "") {
      directives.conversation = conversationId;
      await client.call("conv.select", {
        conversationId,
        shell: shellInfo(args),
        previousConversationId: args.conversationId,
      });
      const status = await client.call<StatusSnapshot>("status.get", {
        conversationId,
      });
      const commands = await client
        .call<{ commands: AgentCommand[] }>("commands.list", { conversationId })
        .catch(() => undefined);
      if (commands !== undefined)
        await cacheCommands(paths, conversationId, commands.commands);
      directives.status = statusLabel({
        ...status,
        state:
          exit === EXIT.aborted
            ? "aborted"
            : exit === EXIT.agentError
              ? "error"
              : status.state,
      });
    }
  } catch (cause) {
    exit = cause instanceof PrefaixError ? cause.exitCode : EXIT.agentError;
    directives.status = "prefaix · error";
    err(`${messageOf(cause)}\n`);
    if (cause instanceof PrefaixError && cause.hint !== undefined) {
      err(`${cause.hint}\n`);
    }
  } finally {
    // Prompt hooks refresh from this file after applying the directives. The
    // foreground owns the final rich status once the daemon ends the turn.
    if (directives.status !== undefined) {
      await writeShellStatus(paths, args.shellId, directives.status).catch(
        () => undefined,
      );
    }
    releaseGuards?.();
    tty?.restore();
    const buffer = bufferFrom(renderer, tty);
    if (buffer !== "") directives.buffer = buffer;
    renderer.close();
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
  const captured = tty?.takeCaptured() ?? "";
  // Drain once, after restore has flushed the decoder and stopped input. A
  // distinct user line remains distinct from an agent-provided suggestion.
  return fromAgent !== "" && captured !== ""
    ? `${fromAgent}\n${captured}`
    : fromAgent + captured;
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
  readonly executePlan?: boolean;
  readonly controller: AbortController;
  readonly setTurnId: (turnId: string) => void;
  readonly setConversationId: (conversationId: string) => void;
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

  const ended = new Promise<TurnSummary>((resolve, reject) => {
    client.onTurnEnd((_turnId, summary) => resolve(summary));
    client.onClose(reject);
  });
  ended.catch(() => undefined);
  client.onEvent((turnId, { event }) => {
    options.setTurnId(turnId);
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
      ...(options.executePlan === undefined
        ? {}
        : { executePlan: options.executePlan }),
      context: {
        recent: built.context.recent,
        os: built.context.os,
        term: built.context.term,
      },
    },
  );
  options.setTurnId(started.turnId);
  options.setConversationId(started.conversationId);

  // Esc aborts locally and tells the daemon, so the turn ends even if the client
  // dies on the way out.
  const onAbort = (): void => {
    void client
      .call("turn.abort", { turnId: started.turnId })
      .catch(() => undefined);
  };
  options.controller.signal.addEventListener("abort", onAbort, { once: true });

  if (options.controller.signal.aborted) onAbort();
  try {
    const summary = await ended;
    return {
      conversationId: started.conversationId,
      exit: exitForSummary(summary),
    };
  } finally {
    options.controller.signal.removeEventListener("abort", onAbort);
    client.onClose(() => undefined);
  }
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

interface CommandResult {
  exit: ExitCode;
  conversationId?: string;
  text?: string;
  executePlan?: boolean;
}

function shellInfo(args: RunArgs) {
  return {
    kind: args.shell,
    version: args.shellVersion,
    shellId: args.shellId,
    pid: args.shellPid,
  };
}

async function runCommand(
  parsed: Extract<Parsed, { kind: "command" }>,
  client: DaemonClient,
  renderer: Renderer,
  args: RunArgs,
  env: Readonly<Record<string, string | undefined>>,
  err: (text: string) => void,
  config: PrefaixConfig,
  options: RunOptions,
): Promise<CommandResult> {
  if (parsed.summary === "Run a persona.")
    throw new PrefaixError("USAGE", `:${parsed.name} requires a prompt`, {
      hint: `Use ':${parsed.name} <text>' to run this persona.`,
    });
  if (parsed.summary === "unknown command") {
    const { commands } = await client
      .call<{ commands: AgentCommand[] }>("commands.list", {
        ...(args.conversationId === ""
          ? {}
          : { conversationId: args.conversationId }),
        cwd: args.cwd,
        env: filterEnv(env, config.env),
      })
      .catch(() => ({ commands: [] as AgentCommand[] }));
    const matching = commands.find(
      (command) => commandAlias(command) === parsed.name,
    );
    if (matching !== undefined)
      return { exit: EXIT.ok, text: commandPrompt(matching, parsed.args) };
    const matches = suggestions(parsed.name, [
      ...COMMAND_NAMES,
      ...Object.keys(config.personas),
      ...commands.map(commandAlias),
    ]);
    err(
      `prefaix: :${parsed.name} is not a command.${matches.length === 0 ? " Use :help to see commands, or ': <text>' to send a prompt." : ` Did you mean ${matches.map((name) => `:${name}`).join(", ")}?`}\n`,
    );
    err(
      `Known personas: ${Object.keys(config.personas).join(", ")}. Use :<persona> <text>.\n`,
    );
    return { exit: EXIT.usage };
  }
  if (!parsed.known) {
    err(
      `prefaix: :${parsed.name} arrives in the ${parsed.milestone} milestone, not this one.\n`,
    );
    return { exit: EXIT.usage };
  }
  const choose =
    options.picker ??
    (async (items: readonly PickItem[], title: string) => {
      const { pick } = await import("./picker.js");
      return pick({
        items,
        title,
        mode: config.ui.picker,
        env,
        out: (text) => err(text),
        ...(options.tty === undefined ? {} : { tty: options.tty }),
        ...(options.rows === undefined ? {} : { rows: options.rows }),
        ...(options.cols === undefined ? {} : { cols: options.cols }),
      });
    });
  if (
    ["model", "m", "think"].includes(parsed.name) &&
    args.conversationId === ""
  )
    throw new PrefaixError("USAGE", "no active conversation; use :new first");
  const sessionParams = {
    conversationId: args.conversationId,
    env: filterEnv(env, config.env),
  };
  switch (parsed.name) {
    case "go":
      if (args.conversationId === "")
        throw new PrefaixError(
          "USAGE",
          "no active plan; use :plan <task> first",
        );
      return { exit: EXIT.ok, text: PLAN_EXECUTION_PROMPT, executePlan: true };
    case "new":
    case "n": {
      const created = await client.call<ConversationSummary>("conv.new", {
        shell: shellInfo(args),
        cwd: args.cwd,
        env: sessionParams.env,
      });
      renderer.notice(`new conversation: ${created.title}`);
      return {
        exit: EXIT.ok,
        conversationId: created.id,
        ...(parsed.args === "" ? {} : { text: parsed.args }),
      };
    }
    case "conversation":
    case "c": {
      if (parsed.args === "-") {
        const selected = await client.call<ConversationSummary>(
          "conv.previous",
          { shellId: args.shellId, fallback: args.previousConversationId },
        );
        renderer.notice(`conversation: ${selected.title}`);
        return { exit: EXIT.ok, conversationId: selected.id };
      }
      const { conversations } = await client.call<{
        conversations: ConversationSummary[];
      }>("conv.list", { query: parsed.args, limit: 100 });
      const exact = conversations.find((c) => c.id === parsed.args);
      if (conversations.length === 0) {
        renderer.notice("no conversations found");
        return { exit: EXIT.ok };
      }
      let id = exact?.id;
      if (id === undefined) {
        const items = await Promise.all(
          conversations.map(async (c) => {
            const { text } = await client.call<{ text: string | null }>(
              "conv.lastText",
              { conversationId: c.id },
            );
            return {
              id: c.id,
              label: `${c.title} · ${c.root} · ${c.id}`,
              preview: `Title: ${plain(c.title)}\nRoot: ${plain(c.root)}\nLast turn: ${plain(text ?? "no assistant text yet")}`,
            };
          }),
        );
        id = await choose(items, "Conversations");
      }
      if (id === undefined) return { exit: EXIT.ok };
      const selected = await client.call<ConversationSummary>("conv.get", {
        conversationId: id,
      });
      renderer.notice(`conversation: ${selected.title}`);
      return { exit: EXIT.ok, conversationId: selected.id };
    }
    case "model":
    case "m": {
      const { models } = await client.call<ModelListResult>(
        "model.list",
        sessionParams,
      );
      const query = parsed.args.toLowerCase();
      const matches = models.filter((m) =>
        `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(query),
      );
      const exact = matches.find(
        (m) => `${m.provider}/${m.id}` === parsed.args || m.id === parsed.args,
      );
      const id =
        exact === undefined
          ? await choose(
              matches.map((m) => ({
                id: `${m.provider}/${m.id}`,
                label: `${m.provider}/${m.id}${m.name === undefined ? "" : ` · ${m.name}`}`,
              })),
              "Models",
            )
          : `${exact.provider}/${exact.id}`;
      if (id === undefined) {
        if (matches.length === 0) renderer.notice("no matching models");
        return { exit: EXIT.ok };
      }
      const model = models.find((m) => `${m.provider}/${m.id}` === id);
      if (model === undefined)
        throw new PrefaixError("USAGE", "the selected model is unavailable");
      await client.call("model.set", {
        ...sessionParams,
        ref: { provider: model.provider, id: model.id },
      });
      renderer.notice(`model: ${id}`);
      return { exit: EXIT.ok };
    }
    case "think": {
      const { levels: thinkingLevels } = await client.call<{
        levels: string[];
      }>("thinking.list", sessionParams);
      const level =
        parsed.args === ""
          ? await choose(
              thinkingLevels.map((id) => ({ id, label: id })),
              "Thinking level",
            )
          : parsed.args;
      if (level === undefined) return { exit: EXIT.ok };
      if (!thinkingLevels.includes(level))
        throw new PrefaixError(
          "USAGE",
          `unknown thinking level ${JSON.stringify(level)}; choose ${thinkingLevels.join(", ")}`,
        );
      await client.call("thinking.set", { ...sessionParams, level });
      renderer.notice(`thinking: ${level}`);
      return { exit: EXIT.ok };
    }
    case "copy": {
      if (args.conversationId === "")
        throw new PrefaixError("USAGE", "no active conversation; run : first");
      const { text } = await client.call<{ text: string | null }>(
        "conv.lastText",
        sessionParams,
      );
      if (text === null || text === "") {
        renderer.notice("no assistant text to copy yet");
        return { exit: EXIT.ok };
      }
      if (options.clipboard !== undefined) await options.clipboard(text);
      else
        await copyText(text, {
          env,
          out: options.out ?? ((value) => process.stdout.write(value)),
          isTty: options.stdoutIsTty ?? process.stdout.isTTY === true,
        });
      renderer.notice("copied the last answer");
      return { exit: EXIT.ok };
    }
    case "info":
    case "i":
      return { exit: await runInfo(client, renderer, args) };
    default:
      return { exit: EXIT.usage };
  }
}

export function statusLabel(status: StatusSnapshot): string {
  const model = status.model?.id ?? "default";
  const context =
    typeof status.contextPct === "number"
      ? ` · ${status.contextPct.toFixed(0)}%`
      : "";
  return plain(`prefaix · ${model}${context} · ${status.state}`).slice(0, 160);
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
    renderer.line(`persona: ${conversation.persona ?? "default"}`);
  }
  renderer.line(`backend: ${status.backend}`);
  if (status.usage !== undefined)
    renderer.line(
      `tokens: ${String(status.usage.input)} in · ${String(status.usage.output)} out`,
    );
  renderer.line(`model: ${modelLabel(status.model)}`);
  if (status.thinking !== undefined) {
    renderer.line(`thinking: ${status.thinking}`);
  }
  const cost = conversation?.costUsd ?? status.usage?.costUsd;
  if (cost !== undefined) renderer.line(`cost: $${cost.toFixed(3)}`);
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
  return model === undefined
    ? "backend default"
    : `${model.provider}/${model.id}`;
}

const HELP_LINES: readonly string[] = [
  "prefaix line grammar:",
  "  : <text>            prompt the active conversation",
  "  :<command> [args]   a prefaix command",
  "  :/<name> [args]     an agent command",
  "  :                   pass through the shell no-op",
  "  \\: <text>           pass through to the shell",
  "",
  "commands:",
  "  :new [text]         start a new conversation",
  "  :conversation [q]   switch conversation (:c - for the last one)",
  "  :model [q]          pick or set the model",
  "  :think <level>      set the thinking level",
  "  :info               what this conversation is doing",
  "  :copy               copy the last answer",
  "  :ask <text>         use read-only tools to answer",
  "  :plan <task>        plan with read-only tools",
  "  :go                 execute the completed plan with normal tools",
  "  :<persona> <text>   use a configured [personas.<name>] persona",
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
  const { mkdir, rename, writeFile } = await import("node:fs/promises");
  const temp = `${target}.${String(process.pid)}.tmp`;
  await mkdir(posix.dirname(target), { recursive: true, mode: 0o700 }).catch(
    () => undefined,
  );
  await writeFile(temp, encodeDirectives(directives), { mode: 0o600 });
  await rename(temp, target);
}

export type { DialogRequest, UiResponse };
