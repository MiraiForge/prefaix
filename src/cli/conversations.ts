// `prefaix conversations {ls,show,rm}` and `prefaix debug tap` (DESIGN §4.3.5).
//
// Both go through the daemon rather than the store, because the daemon is what
// owns the conversation index while it is running; reading the files behind its
// back would race the turn that is writing them.

import { EXIT, type ExitCode, messageOf } from "../core/errors.js";
import { DaemonClient } from "../client/connection.js";
import { resolvePaths } from "../core/paths.js";
import type { PrefaixPaths } from "../core/paths.js";
import type { ConversationSummary } from "../core/protocol.js";

export interface ConversationsIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly paths: PrefaixPaths;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly version?: string;
}

const USAGE = `prefaix conversations <command>

  ls [query]            list conversations, newest first
  show <id> [--last]    show one conversation and its last answer
  rm <id>               remove a conversation from prefaix's index
`;

export async function runConversations(
  argv: readonly string[],
  io: ConversationsIo,
): Promise<ExitCode> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "ls" || sub === "list") {
    return list(rest, io);
  }
  if (sub === "show") {
    return show(rest, io);
  }
  if (sub === "rm" || sub === "remove") {
    return remove(rest, io);
  }
  io.err(`prefaix conversations: unknown subcommand ${JSON.stringify(sub)}\n`);
  io.err(USAGE);
  return EXIT.usage;
}

async function connect(io: ConversationsIo): Promise<DaemonClient> {
  const client = new DaemonClient({
    paths: io.paths,
    version: io.version ?? "0.0.0",
  });
  await client.connect();
  return client;
}

async function list(
  argv: readonly string[],
  io: ConversationsIo,
): Promise<ExitCode> {
  const client = await connect(io);
  try {
    const query = argv.filter((token) => !token.startsWith("--")).join(" ");
    const result = await client.call<{ conversations: ConversationSummary[] }>(
      "conv.list",
      query === "" ? {} : { query },
    );
    if (result.conversations.length === 0) {
      io.out(
        query === ""
          ? "no conversations yet\n"
          : `nothing matches ${JSON.stringify(query)}\n`,
      );
      return EXIT.ok;
    }
    for (const conversation of result.conversations) {
      io.out(
        `${conversation.id}  ${String(conversation.turns).padStart(3)} turns  ${conversation.title}\n`,
      );
      io.out(
        `  root ${conversation.root} · ${conversation.createdBy.shell} · ${conversation.updatedAt}\n`,
      );
    }
    return EXIT.ok;
  } finally {
    client.close();
  }
}

async function show(
  argv: readonly string[],
  io: ConversationsIo,
): Promise<ExitCode> {
  const id = argv.find((token) => !token.startsWith("--"));
  if (id === undefined) {
    io.err("prefaix conversations show: an id is required\n");
    return EXIT.usage;
  }
  const client = await connect(io);
  try {
    const conversation = await client.call<ConversationSummary>("conv.get", {
      conversationId: id,
    });
    io.out(`${conversation.title}\n`);
    io.out(`id          ${conversation.id}\n`);
    io.out(`backend     ${conversation.backend}\n`);
    io.out(`root        ${conversation.root}\n`);
    io.out(`turns       ${String(conversation.turns)}\n`);
    io.out(
      `created     ${conversation.createdAt} by ${conversation.createdBy.shell}\n`,
    );
    io.out(`updated     ${conversation.updatedAt}\n`);
    if (conversation.model !== undefined) {
      io.out(
        `model       ${conversation.model.provider}/${conversation.model.id}\n`,
      );
    }
    if (conversation.thinking !== undefined) {
      io.out(`thinking    ${conversation.thinking}\n`);
    }
    if (argv.includes("--last")) {
      const last = await client.call<{ text: string | null }>("conv.lastText", {
        conversationId: id,
      });
      io.out("\nlast answer:\n");
      io.out(last.text ?? "(no completed turn yet)\n");
    }
    return EXIT.ok;
  } finally {
    client.close();
  }
}

async function remove(
  argv: readonly string[],
  io: ConversationsIo,
): Promise<ExitCode> {
  const id = argv.find((token) => !token.startsWith("--"));
  if (id === undefined) {
    io.err("prefaix conversations rm: an id is required\n");
    return EXIT.usage;
  }
  const client = await connect(io);
  try {
    // The daemon owns the index, so removal goes through it. A conversation
    // with a warm child is released first, or the child would keep writing to a
    // file that no longer has an index entry.
    await client.call("conv.get", { conversationId: id });
    await client.call("conv.rm", { conversationId: id });
    io.out(`removed ${id}\n`);
    return EXIT.ok;
  } finally {
    client.close();
  }
}

export interface TapIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly paths: PrefaixPaths;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly version: string;
}

/**
 * `debug tap`: the raw adapter events for a conversation, one JSON record per
 * line. This is the tool for "pi changed and my turn stopped rendering", so it
 * prints what the daemon actually relayed rather than anything reconstructed.
 */
export async function runTap(id: string, io: TapIo): Promise<ExitCode> {
  const client = new DaemonClient({ paths: io.paths, version: io.version });
  try {
    await client.connect();
    client.onEvent((turnId, { seq, event }) => {
      io.out(`${JSON.stringify({ turnId, seq, event })}\n`);
    });
    // The settle is the line a reader most wants, and it arrives on a different
    // message than the events, so it is printed too rather than inferred.
    client.onTurnEnd((turnId, summary) => {
      io.out(`${JSON.stringify({ turnId, summary })}\n`);
    });
    // The replayed events already name the turn, so nothing else is printed:
    // a tap is a stream of records, not a report.
    await client.call("turn.attach", { conversationId: id, fromSeq: 1 });
    return EXIT.ok;
  } catch (cause) {
    io.err(`prefaix debug tap: ${messageOf(cause)}\n`);
    return cause instanceof Error && "exitCode" in cause
      ? (cause as { exitCode: ExitCode }).exitCode
      : EXIT.agentError;
  } finally {
    client.close();
  }
}

export function defaultIo(
  env: NodeJS.ProcessEnv,
  version: string,
): ConversationsIo {
  return {
    env,
    paths: resolvePaths(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    version,
  };
}
