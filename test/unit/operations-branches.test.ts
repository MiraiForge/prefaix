// The paths through `Operations` that only a misbehaving agent, a rude client,
// or a dying socket can reach. The happy paths live in operations.test.ts; this
// file is about what happens when something underneath a turn breaks, because
// those are the branches that must not take the daemon with them.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentPool } from "../../src/daemon/pool.js";
import { ConversationStore } from "../../src/daemon/store.js";
import { TurnManager } from "../../src/daemon/turns.js";
import { Operations, workspaceRoot } from "../../src/daemon/operations.js";
import { resolvePaths, type PrefaixPaths } from "../../src/core/paths.js";
import { createStatusFiles } from "../../src/daemon/status.js";
import { defaultConfig } from "../../src/core/config/schema.js";
import { newConversationId } from "../../src/core/ids.js";
import type {
  AgentBackend,
  AgentCommand,
  AgentEvent,
  AgentSession,
  AgentState,
  Capabilities,
  ModelInfo,
  NativeRef,
} from "../../src/core/agent-port.js";
import type { Connection } from "../../src/daemon/server.js";
import type { DaemonMessage, TurnSummary } from "../../src/core/protocol.js";

/** A promise the test resolves by hand, for the gates the stub waits on. */
function gate(): { promise: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const CAPABILITIES: Capabilities = {
  steer: false,
  followUp: false,
  abort: true,
  models: true,
  thinkingLevels: true,
  compact: true,
  slashCommands: true,
  skills: true,
  uiDialogs: true,
  contextSections: true,
  personasWithoutRespawn: true,
  handoffTui: false,
};

/**
 * A session that waits to be let go before it emits anything. The gate is what
 * lets a test hold a turn open, decide what the agent does next, and only then
 * watch the turn settle.
 */
class StubSession implements AgentSession {
  native: NativeRef = { sessionId: "stub" };
  /**
   * Thrown instead of the first event, to model an agent that dies. Typed as
   * unknown because a child process can fail in ways that are not Errors.
   */
  throwOnPrompt: unknown;
  /** Extra events to emit, for the paths a plain turn never reaches. */
  extraEvents: AgentEvent[] = [];
  /** Hold the turn open after the extra events, for a dialog to be answered. */
  holdAfterExtras = false;
  stateResult: AgentState = { busy: false };
  stateThrows = false;
  closed = false;
  readonly #gate = gate();
  readonly #afterExtras = gate();

  flush(): void {
    this.#gate.open();
  }

  /** Lets a held turn run on to the rest of its events. */
  release(): void {
    this.#afterExtras.open();
  }

  async *prompt(): AsyncIterable<AgentEvent> {
    await this.#gate.promise;
    if (this.throwOnPrompt !== undefined) {
      throw this.throwOnPrompt;
    }
    yield { type: "turn_start" };
    for (const event of this.extraEvents) {
      yield event;
    }
    if (this.holdAfterExtras) {
      await this.#afterExtras.promise;
    }
    yield { type: "text_delta", block: 0, text: "hi" };
    yield { type: "text_end", block: 0 };
    yield { type: "usage", input: 1, output: 2 };
    yield { type: "settled", stopReason: "stop" };
  }

  async abort(): Promise<void> {}

  respondUi(): void {}

  async state(): Promise<AgentState> {
    if (this.stateThrows) {
      throw new Error("the child is gone");
    }
    return this.stateResult;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { provider: "stub", id: "stub-1", name: "Stub", contextWindow: 1_000 },
    ];
  }

  async setModel(): Promise<void> {}

  async lastAssistantText(): Promise<string | null> {
    return "hi";
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** The same session with every optional method taken away. */
class BareSession extends StubSession {
  declare setThinking: undefined;
  declare listCommands: undefined;
  declare compact: undefined;
}

class StubBackend implements AgentBackend {
  readonly id = "stub";
  readonly capabilities = CAPABILITIES;
  readonly sessions: StubSession[] = [];
  bare = false;
  /** Armed before the turn starts, so a fresh session is taught to fail too. */
  throwOnPrompt: Error | undefined;

  async probe() {
    return {
      installed: true,
      version: "stub",
      usable: true,
      ok: true as const,
    };
  }

  async open(): Promise<AgentSession> {
    const session = this.bare ? new BareSession() : new StubSession();
    session.throwOnPrompt = this.throwOnPrompt;
    this.sessions.push(session);
    return session;
  }
}

let home = "";
let paths: PrefaixPaths;
let backend: StubBackend;
let pool: AgentPool;
let store: ConversationStore;
let turns: TurnManager;
let sent: DaemonMessage[];
let ended: { summary: TurnSummary; root: string }[];
let clock = 1_000;

function connection(id: string): Connection {
  return { id } as unknown as Connection;
}

function operations(
  overrides: Partial<ConstructorParameters<typeof Operations>[0]> = {},
): Operations {
  return new Operations({
    store,
    pool,
    turns,
    config: defaultConfig(),
    version: "0.0.0-test",
    startedAt: 1_000,
    ...overrides,
    send: (_connection, message) => {
      sent.push(message);
    },
    onEnd: (_turn, summary, info) => {
      ended.push({ summary, root: info.root });
    },
  });
}

function splitPolicy(): ReturnType<typeof defaultConfig> {
  return {
    ...defaultConfig(),
    workspace: { ...defaultConfig().workspace, cwdPolicy: "split" },
  };
}

const shell = { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 };
const context = {
  recent: [],
  os: "macOS",
  term: { cols: 100, rows: 30, colors: 256 },
};

async function startTurn(
  ops: Operations,
  overrides: Record<string, unknown> = {},
  owner = "c1",
): Promise<{ turnId: string; conversationId: string }> {
  return (await ops.turnStart(
    {
      shell,
      cwd: home,
      env: { PATH: "/usr/bin" },
      text: "hello",
      context,
      ...overrides,
    } as never,
    connection(owner),
  )) as { turnId: string; conversationId: string };
}

/**
 * Lets the agent go and waits for the turn to be over. A turn that ran to the
 * end also gets its after-turn hook, and the hook is what persists the record,
 * so waiting for it is what makes the assertions afterwards deterministic.
 * A turn released by a client going away never gets one, and is waited for
 * differently.
 */
async function settleTurn(
  turnId: string,
  options: { afterTurnHook?: boolean } = {},
): Promise<void> {
  for (const session of backend.sessions) {
    session.flush();
  }
  const isOver = (): boolean =>
    options.afterTurnHook === false
      ? turns.get(turnId) === undefined
      : ended.some((entry) => entry.summary.turnId === turnId);
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (isOver()) {
        resolve();
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

/** The real store, with its writes failing the way a full disk would. */
function storeThatCannotWrite(): ConversationStore {
  const real = store;
  return {
    paths: real.paths,
    get: (id: string) => real.get(id),
    list: () => real.list(),
    lastInRoot: (root: string) => real.lastInRoot(root),
    remove: (id: string) => real.remove(id),
    save: (record: Parameters<typeof real.save>[0]) => real.save(record),
    update: () => Promise.reject(new Error("disk is full")),
  } as unknown as ConversationStore;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function events(): AgentEvent[] {
  return sent.flatMap((message) => (message.t === "evt" ? [message.e] : []));
}

/** Teaches every session, warm or not, to fail the next turn. */
function armFailure(message: string): void {
  backend.throwOnPrompt = new Error(message);
  for (const session of backend.sessions) {
    session.throwOnPrompt = new Error(message);
  }
}

async function waitForAsync(
  condition: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-opsb-"));
  paths = resolvePaths({
    env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
    home,
  });
  backend = new StubBackend();
  pool = new AgentPool({ backend, config: defaultConfig(), spare: false });
  store = new ConversationStore({ paths });
  turns = new TurnManager();
  sent = [];
  ended = [];
  clock = 1_000;
});

afterEach(async () => {
  for (const session of backend.sessions) {
    session.flush();
    await session.close();
  }
  rmSync(home, { recursive: true, force: true });
});

describe("a turn whose agent breaks", () => {
  it("reports the failure and still settles the turn", async () => {
    const ops = operations();
    const first = await startTurn(ops);
    await settleTurn(first.turnId);
    armFailure("the model fell over");
    // A second turn on the same conversation picks up the warm session, which
    // is the one that has been taught to fail.
    const second = await startTurn(ops, {
      conversationId: first.conversationId,
      text: "boom",
    });
    await settleTurn(second.turnId);
    expect(
      events().filter(
        (event) => event?.type === "notice" && event.level === "error",
      ),
    ).toHaveLength(1);
    console.error("DBG events", JSON.stringify(events()));
    expect(ended.at(-1)?.summary).toMatchObject({
      status: "error",
      error: "the model fell over",
    });
    expect(
      events().find(
        (event) => event?.type === "settled" && event.stopReason === "error",
      ),
    ).toBeDefined();
  });

  it("settles as aborted, not failed, when the signal is the reason", async () => {
    const ops = operations();
    const { turnId } = await startTurn(ops);
    armFailure("stopped");
    turns.get(turnId)?.controller.abort("client asked");
    await settleTurn(turnId);
    expect(ended.at(-1)?.summary).toEqual({ turnId, status: "aborted" });
    const settled = events().find((event) => event.type === "settled");
    expect(settled).toMatchObject({ stopReason: "aborted" });
    expect(settled && "error" in settled).toBe(false);
  });

  it("leaves a failed turn's counters alone", async () => {
    const ops = operations();
    const first = await startTurn(ops);
    await settleTurn(first.turnId);
    await waitForAsync(
      async () => (await store.get(first.conversationId))?.stats.turns === 1,
    );

    armFailure("nope");
    const second = await startTurn(ops, {
      conversationId: first.conversationId,
    });
    await settleTurn(second.turnId);
    // A turn that failed never joins the conversation's counter.
    await waitForAsync(
      async () => (await store.get(first.conversationId))?.stats.turns === 1,
    );
  });

  it("survives a record it cannot write", async () => {
    const messages: string[] = [];
    const ops = operations({
      store: storeThatCannotWrite(),
      log: (message) => messages.push(message),
    });
    const { turnId } = await startTurn(ops);
    await settleTurn(turnId);
    expect(messages).toContain("could not update the conversation record");
    expect(ended).toHaveLength(1);
  });

  it("records the model, thinking level, cost, and context the turn reported", async () => {
    const ops = operations();
    const { turnId, conversationId } = await startTurn(ops);
    (backend.sessions[0] as StubSession).stateResult = {
      busy: false,
      model: { provider: "stub", id: "stub-1" },
      thinking: "high",
      usage: { input: 10, output: 20, costUsd: 0.5 },
      contextPct: 12,
    };
    await settleTurn(turnId);
    const record = await store.get(conversationId);
    expect(record?.model).toEqual({ provider: "stub", id: "stub-1" });
    expect(record?.thinking).toBe("high");
    expect(record?.stats.costUsd).toBe(0.5);
    expect(record?.stats.lastContextPct).toBe(12);
  });

  it("accumulates cost across turns and carries the last context reading", async () => {
    const ops = operations();
    const first = await startTurn(ops);
    (backend.sessions[0] as StubSession).stateResult = {
      busy: false,
      usage: { input: 1, output: 1, costUsd: 0.25 },
      contextPct: 5,
    };
    await settleTurn(first.turnId);
    const session = backend.sessions[0] as StubSession;
    session.stateResult = {
      busy: false,
      usage: { input: 1, output: 1, costUsd: 0.25 },
    };
    const second = await startTurn(ops, {
      conversationId: first.conversationId,
    });
    await settleTurn(second.turnId);
    const record = await store.get(first.conversationId);
    expect(record?.stats.costUsd).toBe(0.5);
    expect(record?.stats.lastContextPct).toBe(5);
  });
});

describe("a client that goes away mid-turn", () => {
  it("aborts the turns it owned and leaves the rest alone", async () => {
    const ops = operations();
    const mine = await startTurn(ops, {}, "c1");
    const theirs = await startTurn(ops, {}, "c2");
    ops.releaseConnection(connection("c2"));
    await settleTurn(theirs.turnId, { afterTurnHook: false });
    expect(turns.get(theirs.turnId)).toBeUndefined();
    expect(turns.get(mine.turnId)).not.toBeUndefined();
    await ops.turnAbort({ turnId: mine.turnId });
    await settleTurn(mine.turnId);
  });

  it("replays a kept turn to whoever attaches next", async () => {
    const ops = operations();
    const { turnId, conversationId } = await startTurn(ops, {
      onDisconnect: "keep",
    });
    await settleTurn(turnId);
    sent = [];
    const attached = await ops.turnAttach(
      { conversationId, fromSeq: 0 },
      connection("c2"),
    );
    expect(attached.turnId).toBe(turnId);
    expect(events().some((event) => event?.type === "settled")).toBe(true);
  });

  it("asks for a conversation id before it attaches to anything", async () => {
    const ops = operations();
    await expect(
      ops.turnAttach({ fromSeq: 0 }, connection("c1")),
    ).rejects.toThrow(/conversation id is required/);
    await expect(
      ops.turnAttach(
        { conversationId: newConversationId(), fromSeq: 0 },
        connection("c1"),
      ),
    ).rejects.toThrow(/no turn on record/);
  });
});

describe("capabilities the agent does not have", () => {
  it("says so for compact, thinking, and commands instead of crashing", async () => {
    backend.bare = true;
    const ops = operations();
    const { turnId, conversationId } = await startTurn(ops);
    await settleTurn(turnId);
    await expect(ops.convCompact({ conversationId })).rejects.toThrow(
      /compact/,
    );
    await expect(
      ops.thinkingSet({ conversationId, level: "high" }),
    ).rejects.toThrow(/think/);
    await expect(ops.commandsList({ conversationId })).rejects.toThrow(/skill/);
  });

  it("passes a command description through only when there is one", async () => {
    const ops = operations();
    const { turnId, conversationId } = await startTurn(ops);
    await settleTurn(turnId);
    const session = backend.sessions[0] as StubSession;
    const commands: AgentCommand[] = [
      { name: "review", kind: "skill", description: "review the diff" },
      { name: "bare", kind: "template" },
    ];
    (pool as unknown as { session(id: string): AgentSession }).session = () =>
      ({
        ...session,
        listCommands: async () => commands,
      }) as unknown as AgentSession;
    expect(await ops.commandsList({ conversationId })).toEqual({
      commands: [
        { name: "review", kind: "skill", description: "review the diff" },
        { name: "bare", kind: "template" },
      ],
    });
  });
});

describe("a cwd that is not the conversation's root", () => {
  it("starts a conversation in the new root when the policy is split", async () => {
    const messages: string[] = [];
    let root = join(home, "first");
    const ops = operations({
      config: splitPolicy(),
      gitRoot: { run: async () => root },
      log: (message) => messages.push(message),
    });
    const first = await startTurn(ops);
    await settleTurn(first.turnId);
    expect((await store.get(first.conversationId))?.root).toBe(root);

    root = join(home, "second");
    const second = await startTurn(ops, {
      conversationId: first.conversationId,
    });
    await settleTurn(second.turnId);
    // The conversation stayed in the root it belongs to and a second one
    // answered in the new one, which is the whole point of `split`.
    expect(second.conversationId).not.toBe(first.conversationId);
    expect((await store.get(second.conversationId))?.root).toBe(root);
    expect((await store.get(first.conversationId))?.root).toBe(
      join(home, "first"),
    );
    expect(messages).toContain("cwd left the conversation root");
  });

  it("joins the conversation already in that root", async () => {
    let root = join(home, "first");
    const ops = operations({
      config: splitPolicy(),
      gitRoot: { run: async () => root },
    });
    const first = await startTurn(ops);
    await settleTurn(first.turnId);
    root = join(home, "second");
    const second = await startTurn(ops);
    await settleTurn(second.turnId);
    expect(second.conversationId).not.toBe(first.conversationId);
    // Back in the first root, so it is the conversation already living there
    // that answers rather than a third empty one.
    root = join(home, "first");
    const back = await startTurn(ops, {
      conversationId: second.conversationId,
    });
    await settleTurn(back.turnId);
    expect(back.conversationId).toBe(first.conversationId);
  });

  it("moves the conversation with the directory when the policy is follow", async () => {
    const messages: string[] = [];
    let root = join(home, "first");
    const ops = operations({
      config: {
        ...defaultConfig(),
        workspace: { ...defaultConfig().workspace, cwdPolicy: "follow" },
      },
      gitRoot: { run: async () => root },
      log: (message) => messages.push(message),
    });
    const { turnId, conversationId } = await startTurn(ops);
    await settleTurn(turnId);
    root = join(home, "second");
    await startTurn(ops, { conversationId });
    await settleTurn(turnId);
    expect((await store.get(conversationId))?.root).toBe(root);
  });

  it("leaves the conversation alone when the policy is stay", async () => {
    let root = join(home, "first");
    const ops = operations({
      config: {
        ...defaultConfig(),
        workspace: { ...defaultConfig().workspace, cwdPolicy: "stay" },
      },
      gitRoot: { run: async () => root },
    });
    const { turnId, conversationId } = await startTurn(ops);
    await settleTurn(turnId);
    root = join(home, "second");
    await startTurn(ops, { conversationId });
    await settleTurn(turnId);
    expect((await store.get(conversationId))?.root).toBe(join(home, "first"));
  });
});

describe("the status file a shell reads", () => {
  it("is empty once the shell is done with it", async () => {
    const status = createStatusFiles(paths);
    await status.writeStatus("1-1-a", "running");
    expect(await status.readStatus("1-1-a")).toBe("running");
    await status.clearStatus("1-1-a");
    expect(await status.readStatus("1-1-a")).toBeUndefined();
    // A shell that never ran a turn has no file, and clearing it is a no-op.
    await expect(status.clearStatus("2-2-b")).resolves.toBeUndefined();
  });
});

describe("a cause that is not an error", () => {
  it("is still reported as something the user can read", async () => {
    const ops = operations();
    const first = await startTurn(ops);
    await settleTurn(first.turnId);
    (backend.sessions[0] as StubSession).throwOnPrompt = "the child vanished";
    const second = await startTurn(ops, {
      conversationId: first.conversationId,
    });
    await settleTurn(second.turnId);
    expect(ended.at(-1)?.summary).toMatchObject({
      status: "error",
      error: "the child vanished",
    });
  });

  it("is still logged when the record cannot be written", async () => {
    const messages: string[] = [];
    const failing = Object.create(storeThatCannotWrite()) as ConversationStore;
    failing.update = () => Promise.reject("the disk said no");
    const ops = operations({
      store: failing,
      log: (message) => messages.push(message),
    });
    const { turnId } = await startTurn(ops);
    await settleTurn(turnId);
    expect(messages).toContain("could not update the conversation record");
  });
});

describe("the workspace root", () => {
  it("is the directory itself when there is no git to ask", async () => {
    // A home directory that is not a repository is the normal case for a
    // throwaway checkout, and it must not fail the turn.
    const bare = join(home, "no-repo");
    mkdirSync(bare, { recursive: true });
    expect(await workspaceRoot(bare)).toBe(bare);
  });

  it("is the directory itself when git cannot be run at all", async () => {
    // The default runner resolves rather than rejects, because a turn must not
    // die over a missing git; a caller that replaces it owes the same contract.
    expect(
      await workspaceRoot(home, { run: () => Promise.resolve(undefined) }),
    ).toBe(home);
  });

  it("is the directory itself when git says nothing useful", async () => {
    expect(
      await workspaceRoot(home, { run: () => Promise.resolve("   ") }),
    ).toBe(home);
  });
});

describe("compaction", () => {
  it("hands the focus through and reports what the agent measured", async () => {
    const ops = operations();
    const { turnId, conversationId } = await startTurn(ops);
    await settleTurn(turnId);
    let asked: string | undefined = "unset";
    (pool as unknown as { session(id: string): AgentSession }).session = () =>
      ({
        compact: async (focus?: string) => {
          asked = focus;
          return { summary: "trimmed", tokensBefore: 900 };
        },
      }) as unknown as AgentSession;
    expect(
      await ops.convCompact({ conversationId, focus: "the diff" }),
    ).toEqual({ summary: "trimmed", tokensBefore: 900 });
    expect(asked).toBe("the diff");
  });

  it("checks the conversation exists before it checks the capability", async () => {
    backend.bare = true;
    const ops = operations();
    await expect(
      ops.convCompact({ conversationId: newConversationId() }),
    ).rejects.toThrow(/no conversation with id/);
  });
});

describe("calls that name a turn or a conversation that is not there", () => {
  it("rejects an unknown turn id", async () => {
    await expect(operations().turnAbort({ turnId: "t_nope" })).rejects.toThrow(
      /no turn with id/,
    );
  });

  it("rejects a dialog answer for a turn the agent is not asking about", async () => {
    const ops = operations();
    const { turnId } = await startTurn(ops);
    await expect(
      ops.uiRespond({ turnId, requestId: "u1", response: { value: "yes" } }),
    ).rejects.toThrow(/never asked for dialog/);
    await settleTurn(turnId);
  });

  it("rejects a dialog answer when the agent is gone", async () => {
    const ops = operations();
    const { turnId } = await startTurn(ops);
    const session = backend.sessions[0] as StubSession;
    session.extraEvents = [
      { type: "ui_request", id: "u1", kind: "confirm", title: "Proceed?" },
    ];
    session.holdAfterExtras = true;
    for (const held of backend.sessions) {
      held.flush();
    }
    await waitFor(() => turns.get(turnId)?.dialogs.size === 1);
    (pool as unknown as { session(id: string): undefined }).session = () =>
      undefined;
    await expect(
      ops.uiRespond({ turnId, requestId: "u1", response: { confirmed: true } }),
    ).rejects.toThrow(/no longer available/);
    session.release();
    await settleTurn(turnId);
  });

  it("answers a dialog the agent did ask about", async () => {
    const ops = operations();
    const { turnId } = await startTurn(ops);
    const session = backend.sessions[0] as StubSession;
    session.extraEvents = [
      { type: "ui_request", id: "u1", kind: "confirm", title: "Proceed?" },
    ];
    session.holdAfterExtras = true;
    for (const held of backend.sessions) {
      held.flush();
    }
    await waitFor(() => turns.get(turnId)?.dialogs.size === 1);
    expect(
      await ops.uiRespond({
        turnId,
        requestId: "u1",
        response: { confirmed: true },
      }),
    ).toEqual({ ok: true });
    session.release();
    await settleTurn(turnId);
  });

  it("rejects a model or thinking call with no conversation in play", async () => {
    const ops = operations();
    await expect(ops.modelList({})).rejects.toThrow(
      /no conversation is in play/,
    );
    await expect(ops.commandsList({})).rejects.toThrow(
      /no conversation is in play/,
    );
  });

  it("rejects a model call for a conversation with no warm agent", async () => {
    const ops = operations();
    const { turnId, conversationId } = await startTurn(ops);
    (pool as unknown as { session(id: string): undefined }).session = () =>
      undefined;
    await expect(ops.modelList({ conversationId })).rejects.toThrow(
      /no warm agent/,
    );
    await settleTurn(turnId);
  });
});

describe("the status a client reads", () => {
  it("reports idle, then busy, and adds a conversation only when asked", async () => {
    const ops = operations();
    const empty = await ops.statusGet({});
    expect(empty.state).toBe("idle");
    expect("conversation" in empty).toBe(false);
    expect("model" in empty).toBe(false);

    const { turnId, conversationId } = await startTurn(ops);
    const busy = await ops.statusGet({ conversationId });
    expect(busy.state).toBe("busy");
    expect(busy.conversation?.id).toBe(conversationId);
    await ops.turnAbort({ turnId });
    await settleTurn(turnId);
  });

  it("carries the model, thinking, usage, and context the agent reports", async () => {
    const ops = operations();
    const { turnId, conversationId } = await startTurn(ops);
    (backend.sessions[0] as StubSession).stateResult = {
      busy: true,
      model: { provider: "stub", id: "stub-1" },
      thinking: "low",
      usage: { input: 3, output: 4 },
      contextPct: null,
    };
    const status = await ops.statusGet({ conversationId });
    expect(status.model).toEqual({ provider: "stub", id: "stub-1" });
    expect(status.thinking).toBe("low");
    expect(status.usage).toEqual({ input: 3, output: 4 });
    // The agent knows it has no number, which is not the same as having none.
    expect(status.contextPct).toBeNull();
    await ops.turnAbort({ turnId });
    await settleTurn(turnId);
  });

  it("still reports a status when the agent cannot be asked for its state", async () => {
    const ops = operations();
    const { turnId, conversationId } = await startTurn(ops);
    (backend.sessions[0] as StubSession).stateThrows = true;
    const status = await ops.statusGet({ conversationId });
    expect(status.version).toBe("0.0.0-test");
    expect("model" in status).toBe(false);
    expect(status.conversation?.id).toBe(conversationId);
    await ops.turnAbort({ turnId });
    await settleTurn(turnId);
  });

  it("measures uptime from the clock it was given", async () => {
    clock = 5_000;
    const ops = operations({ now: () => clock });
    expect((await ops.statusGet({})).uptimeMs).toBe(4_000);
  });
});
