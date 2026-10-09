import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, statusLabel, type RunOptions } from "../../src/client/run.js";
import { PrefaixError } from "../../src/core/errors.js";
import { Daemon } from "../../src/daemon/daemon.js";
import { DaemonClient } from "../../src/client/connection.js";
import {
  defaultConfig,
  type PrefaixConfig,
} from "../../src/core/config/schema.js";
import { FakeSession } from "../../src/agents/fake/adapter.js";
import { PLAN_EXECUTION_PROMPT } from "../../src/core/protocol.js";
import {
  resolvePaths,
  shellHintsFile,
  shellRuntimeFiles,
} from "../../src/core/paths.js";
import { decodeDirectives } from "../../src/shells/directives.js";
import type { RawModeTarget } from "../../src/client/tty.js";

let home: string;
let paths: ReturnType<typeof resolvePaths>;
let daemon: Daemon | undefined;
let output: string[];
let errors: string[];
const config = {
  ...defaultConfig(),
  agent: { ...defaultConfig().agent, backend: "fake" as const },
};
function input() {
  let listener: ((text: string) => void) | undefined;
  const modes: boolean[] = [];
  const tty: RawModeTarget = {
    setRawMode: (raw) => {
      modes.push(raw);
      return raw;
    },
    on: (_event, fn) => {
      listener = fn;
    },
    removeAllListeners: () => {
      listener = undefined;
    },
  };
  return { tty, modes, send: (text: string) => listener?.(text) };
}
function directives() {
  return decodeDirectives(readFileSync(join(home, "directives")))!;
}
function activeSession() {
  return daemon!.pool.session(directives().conversation!) as FakeSession;
}

function cachedStatus() {
  return readFileSync(shellRuntimeFiles(paths, "1-1-a").status, "utf8").trim();
}
function invoke(
  line: string,
  conversation = "",
  options: Partial<RunOptions> = {},
  previous = "",
) {
  return run({
    argv: [
      "--shell",
      "zsh",
      "--shell-id",
      "1-1-a",
      "--shell-pid",
      String(process.pid),
      "--nonce",
      "n",
      "--directives",
      join(home, "directives"),
      "--cwd",
      home,
      "--conversation",
      conversation,
      "--previous-conversation",
      previous,
      "--",
      line,
    ],
    version: "test",
    paths,
    config,
    env: { PATH: "/usr/bin", HOME: home },
    out: (text) => output.push(text),
    err: (text) => errors.push(text),
    tty: input().tty,
    stdoutIsTty: false,
    ...options,
  });
}
async function start(
  env: Record<string, string> = {},
  settings: PrefaixConfig = config,
) {
  daemon = new Daemon({
    paths,
    config: settings,
    version: "test",
    checkOwner: false,
    env: { PATH: "/usr/bin", HOME: home, ...env },
  });
  await daemon.start();
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-commands-"));
  paths = resolvePaths({
    home,
    env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
  });
  output = [];
  errors = [];
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe("suggest command workflows", () => {
  it.each([":suggest find a file", ":s find a file", ": suggest find a file"])(
    "routes %s as a distinct edit operation",
    async (line) => {
      await start();
      const calls: string[] = [];
      expect(
        await invoke(line, "", {
          connect: (options) => {
            const client = new DaemonClient(options);
            const call = client.call.bind(client);
            client.call = async (op, params) => {
              calls.push(op);
              return call(op, params);
            };
            return client;
          },
        }),
      ).toBe(0);
      expect(calls).toContain("turn.suggest");
      expect(calls).not.toContain("turn.start");
      expect(directives().buffer).toBe("printf '%s\\n' 'fake suggestion'");
      expect(activeSession().lastPrompt?.text).toBe("find a file");
      expect(activeSession().lastPrompt?.commandProposal).toBe(true);
    },
  );
  it.each([":s", ":suggest", ":suggest   "])(
    "rejects empty %s without a prompt",
    async (line) => {
      await start();
      expect(await invoke(line)).toBe(2);
      expect(errors.join("")).toContain(":suggest requires a request");
      expect(await daemon!.store.list()).toEqual([]);
      expect(directives().buffer).toBeUndefined();
    },
  );
  it("returns literal command data plus separate user typeahead and restores raw mode", async () => {
    const command = "printf '%s' 日本語🙂\n\techo done";
    await start({ PREFAIX_FAKE_PROPOSAL: command });
    const terminal = input();
    expect(
      await invoke(":s do it", "", {
        tty: terminal.tty,
        connect: (options) => {
          const client = new DaemonClient(options);
          const call = client.call.bind(client);
          client.call = async (op, params) => {
            if (op === "turn.suggest") terminal.send("typed later");
            return call(op, params);
          };
          return client;
        },
      }),
    ).toBe(0);
    expect(directives().buffer).toBe(command + "\ntyped later");
    expect(terminal.modes).toEqual([true, false]);
  });
  it.each(["metadata failure", "late abort"])(
    "withdraws the generated buffer on %s after settlement",
    async (failure) => {
      await start();
      const terminal = input();
      const exit = await invoke(":s find file", "", {
        tty: terminal.tty,
        connect: (options) => {
          const client = new DaemonClient(options);
          const call = client.call.bind(client);
          client.call = async (op, params) => {
            if (op === "status.get" && failure === "metadata failure")
              throw new Error("metadata failed");
            if (op === "commands.list" && failure === "late abort")
              terminal.send("\x03");
            return call(op, params);
          };
          return client;
        },
      });
      expect(exit).toBe(failure === "late abort" ? 130 : 1);
      expect(directives().buffer).toBeUndefined();
      expect(terminal.modes).toEqual([true, false]);
    },
  );
  it("does not turn prose into a command when no proposal was returned", async () => {
    await start({ PREFAIX_FAKE_SCENARIO: "tools" });
    expect(await invoke(":s find file")).toBe(1);
    expect(directives().buffer).toBeUndefined();
  });
});

describe("persona command workflows", () => {
  it("routes built-ins, preserves the persona, and executes a plan in the same conversation", async () => {
    await start();
    expect(await invoke(":ask why is this slow")).toBe(0);
    const conversation = directives().conversation!;
    const original = activeSession();
    expect(original.lastPrompt?.persona?.tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
    ]);
    expect(original.lastPrompt?.text).toBe("why is this slow");
    expect(await invoke(": what about this?", conversation)).toBe(0);
    expect(original.lastPrompt?.persona?.name).toBe("ask");
    expect(await invoke(":plan refactor it", conversation)).toBe(0);
    expect(original.lastPrompt?.persona?.name).toBe("plan");
    expect(await invoke(":info", conversation)).toBe(0);
    expect(output.join("")).toContain("persona: plan");
    expect(await invoke(":go", conversation)).toBe(0);
    expect(directives().conversation).toBe(conversation);
    expect(activeSession()).toBe(original);
    expect(original.lastPrompt?.text).toBe(PLAN_EXECUTION_PROMPT);
    expect(original.persona).toBeUndefined();
    output = [];
    expect(await invoke(":info", conversation)).toBe(0);
    expect(output.join("")).toContain("persona: default");
  });

  it("routes configured personas and suggests misspelled names without prompting", async () => {
    const custom = {
      ...config,
      personas: {
        ...config.personas,
        audit: { tools: ["read"], guideline: "Audit dependencies." },
      },
    };
    await start({}, custom);
    expect(
      await invoke(":audit the deps\nverbatim second line", "", {
        config: custom,
      }),
    ).toBe(0);
    expect(activeSession().lastPrompt).toMatchObject({
      text: "the deps\nverbatim second line",
      persona: {
        name: "audit",
        tools: ["read"],
        guideline: "Audit dependencies.",
      },
    });
    const conversation = directives().conversation!;
    const original = activeSession();
    expect(
      await invoke(":audti the deps", conversation, { config: custom }),
    ).toBe(2);
    expect(errors.join("")).toContain("Did you mean :audit?");
    expect(original.turnsRun).toBe(1);
  });

  it.each([":ask", ":plan", ":audit"])(
    "asks for missing persona text with %s",
    async (line) => {
      const custom = {
        ...config,
        personas: {
          ...config.personas,
          audit: { tools: ["read"], guideline: null },
        },
      };
      await start({}, custom);
      expect(await invoke(line, "", { config: custom })).toBe(2);
      expect(errors.join("")).toContain("requires a prompt");
      expect(errors.join("")).toContain(`${line} <text>`);
      expect(await daemon!.store.list()).toHaveLength(0);
    },
  );

  it("refuses :go before a plan, after an ordinary answer, and with arguments", async () => {
    await start();
    expect(await invoke(":go")).toBe(2);
    expect(errors.join("")).toContain(":plan <task>");
    expect(await daemon!.store.list()).toHaveLength(0);
    expect(await invoke(": explain")).toBe(0);
    const conversation = directives().conversation!;
    expect(await invoke(":go", conversation)).toBe(2);
    expect(errors.join("")).toContain("no completed plan");
    expect(await invoke(":go extra", conversation)).toBe(2);
    expect(errors.join("")).toContain("does not take arguments");
    expect(daemon!.pool.session(conversation)).toMatchObject({ turnsRun: 1 });
  });
});

describe("MVP command workflows", () => {
  it("runs help aliases and doctor without config parsing or a daemon", async () => {
    const connect = vi.fn(() => {
      throw new Error("must not connect");
    });
    const doctor = vi.fn(async () => 0 as const);
    for (const name of [":help", ":?", ":help model"])
      expect(await invoke(name, "", { connect })).toBe(0);
    expect(await invoke(":doctor", "", { doctor, connect })).toBe(0);
    expect(doctor).toHaveBeenCalledWith(
      expect.objectContaining({ shell: "zsh" }),
    );
    expect(connect).not.toHaveBeenCalled();
    expect(await invoke(":doctor", "", { connect })).toBe(2);
    expect(errors.join("")).toContain("unavailable in this client host");
  });
  it("returns the newly created id for both new aliases and prompts it in raw mode", async () => {
    await start();
    await invoke(":new");
    const first = directives().conversation!;
    expect(first).toMatch(/^c_/u);
    const tty = input();
    expect(await invoke(":n second topic", first, { tty: tty.tty })).toBe(0);
    const second = directives().conversation!;
    expect(second).not.toBe(first);
    expect(tty.modes).toEqual([true, false]);
    expect(directives().status).toContain("fake");
    expect(cachedStatus()).toBe(directives().status);
    expect(
      statSync(shellRuntimeFiles(paths, "1-1-a").status).mode & 0o777,
    ).toBe(0o600);
    expect(await invoke(":i", second)).toBe(0);
    expect(output.join("")).toContain("1 turns");
    expect(output.join("")).toContain("second topic");
    expect(output.join("")).toContain("tokens:");
  });
  it("switches exact ids, picker results, and previous conversations across daemon restarts", async () => {
    await start();
    await invoke(":new first");
    const first = directives().conversation!;
    await invoke(":new second", first);
    const second = directives().conversation!;
    expect(await invoke(`:conversation ${first}`, second)).toBe(0);
    expect(directives().conversation).toBe(first);
    await daemon!.stop();
    await start();
    expect(await invoke(":c -", first)).toBe(0);
    expect(directives().conversation).toBe(second);
    const picker = vi.fn(async () => first);
    expect(await invoke(":c", second, { picker })).toBe(0);
    expect(picker.mock.calls.length).toBe(1);
    expect(picker).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          preview: expect.stringContaining("Hello from the fake backend"),
        }),
      ]),
      "Conversations",
    );
    expect(directives().conversation).toBe(first);
    expect(await invoke(":c -", first, {}, second)).toBe(0);
    expect(directives().conversation).toBe(second);
  });
  it("handles no matches, cancellation, and missing previous conversations", async () => {
    await start();
    expect(await invoke(":c missing")).toBe(0);
    expect(errors.join("")).toContain("no conversations found");
    expect(await invoke(":c -")).toBe(2);
    await invoke(":new");
    const id = directives().conversation!;
    expect(await invoke(":c", id, { picker: async () => undefined })).toBe(0);
    expect(directives().conversation).toBe(id);
  });
  it("sets models before a first prompt and restores model, thinking and last text after restart", async () => {
    await start();
    await invoke(":new");
    const id = directives().conversation!;
    expect(await invoke(":model fake-slow", id)).toBe(0);
    expect(await invoke(":think high", id)).toBe(0);
    await invoke(": explain this", id);
    await daemon!.stop();
    await start();
    await invoke(":info", id);
    expect(output.join("")).toContain("model: fake/fake-slow");
    expect(output.join("")).toContain("thinking: high");
    const clipboard = vi.fn(async () => undefined);
    expect(await invoke(":copy", id, { clipboard })).toBe(0);
    expect(clipboard).toHaveBeenCalledWith(
      expect.stringContaining("Hello from the fake backend"),
    );
    expect(await invoke(":m fake-fast", id)).toBe(0);
    expect(directives().status).toContain("fake-fast");
    expect(cachedStatus()).toBe(directives().status);
    clipboard.mockClear();
    await invoke(":copy", id, { clipboard });
    expect(clipboard).toHaveBeenCalledWith(
      expect.stringContaining("Hello from the fake backend"),
    );
  });
  it("picks and validates model and thinking arguments", async () => {
    await start();
    await invoke(":new");
    const id = directives().conversation!;
    expect(
      await invoke(":m", id, { picker: async () => "fake/fake-slow" }),
    ).toBe(0);
    expect(
      await invoke(":model nonexistent", id, { picker: async () => undefined }),
    ).toBe(0);
    expect(errors.join("")).toContain("no matching models");
    expect(
      await invoke(":m", id, { picker: async () => "injected/missing" }),
    ).toBe(2);
    expect(await invoke(":think", id, { picker: async () => "low" })).toBe(0);
    expect(await invoke(":think", id, { picker: async () => undefined })).toBe(
      0,
    );
    expect(await invoke(":think impossible", id)).toBe(2);
    expect(errors.join("")).toContain("choose off, low, medium, high");
    expect(await invoke(":copy", id)).toBe(0);
    expect(errors.join("")).toContain("no assistant text");
  });
  it("copies through the host clipboard function only for an existing answer", async () => {
    await start();
    await invoke(":new");
    const id = directives().conversation!;
    const clipboard = vi.fn(async () => undefined);
    await invoke(":copy", id, { clipboard });
    expect(clipboard).not.toHaveBeenCalled();
    await invoke(": answer", id);
    expect(await invoke(":copy", id, { clipboard })).toBe(0);
    expect(clipboard).toHaveBeenCalledOnce();
  });
  it("returns a daemon error and restores raw mode when the daemon dies mid-turn", async () => {
    await start();
    const tty = input();
    let client: DaemonClient | undefined;
    const pending = invoke(": answer", "", {
      tty: tty.tty,
      connect: (options) => {
        client = new DaemonClient(options);
        const call = client.call.bind(client);
        client.call = async (op, params) => {
          if (op !== "turn.start") return call(op, params);
          const data = await call(op, {
            ...(params as object),
            env: { PREFAIX_FAKE_SCENARIO: "long" },
          });
          client!.close();
          return data as never;
        };
        return client;
      },
    });
    expect(await pending).toBe(3);
    expect(directives().conversation).toMatch(/^c_/u);
    expect(directives().status).toContain("error");
    expect(tty.modes).toEqual([true, false]);
  });
  it("honors cancellation arriving before the turn.start response", async () => {
    await start();
    const tty = input();
    expect(
      await invoke(":new answer", "", {
        tty: tty.tty,
        connect: (options) => {
          const client = new DaemonClient(options);
          const call = client.call.bind(client);
          client.call = async (op, params) => {
            if (op !== "turn.start") return call(op, params);
            tty.send("\u0003");
            return call(op, {
              ...(params as object),
              env: { PREFAIX_FAKE_SCENARIO: "long" },
            });
          };
          return client;
        },
      }),
    ).toBe(130);
    expect(tty.modes).toEqual([true, false]);
    expect(directives().status).toContain("aborted");
    expect(cachedStatus()).toBe(directives().status);
  });
  it("publishes the final error status to the prompt cache", async () => {
    await start({ PREFAIX_FAKE_SCENARIO: "error" });
    expect(
      await invoke(": answer", "", {
        env: { PATH: "/usr/bin", HOME: home, PREFAIX_FAKE_SCENARIO: "error" },
      }),
    ).toBe(1);
    expect(directives().status).toContain("error");
    expect(cachedStatus()).toBe(directives().status);
  });
  it("restores input and writes directives when the optional status cache cannot be replaced", async () => {
    await start();
    mkdirSync(shellRuntimeFiles(paths, "1-1-a").status, { recursive: true });
    const tty = input();
    expect(await invoke(": answer", "", { tty: tty.tty })).toBe(0);
    expect(directives().status).toContain("prefaix");
    expect(tty.modes).toEqual([true, false]);
  });
  it("discards corrupt hints and garbage-collects dead shells", async () => {
    await start();
    await invoke(":new");
    const first = directives().conversation!;
    writeFileSync(
      shellHintsFile(paths, "2-2-a"),
      JSON.stringify({ pid: 2147483647 }),
    );
    writeFileSync(shellHintsFile(paths, "3-3-a"), "bad json");
    writeFileSync(join(paths.shellHintsDir, "unrelated.txt"), "untouched");
    writeFileSync(shellHintsFile(paths, "1-1-a"), "bad json");
    expect(await invoke(":c -")).toBe(2);
    await invoke(":new", first);
    expect(() => readFileSync(shellHintsFile(paths, "2-2-a"))).toThrow();
    expect(
      readFileSync(join(paths.shellHintsDir, "unrelated.txt"), "utf8"),
    ).toBe("untouched");
  });
  it("runs the default raw picker and clipboard fallback through the command path", async () => {
    await start();
    await invoke(":new topic");
    const id = directives().conversation!;
    const terminal = input();
    const choosing = invoke(":m", id, {
      tty: terminal.tty,
      config: { ...config, ui: { ...config.ui, picker: "builtin" } },
    });
    await vi.waitFor(() => expect(terminal.modes).toEqual([true]));
    terminal.send("\u001b[B\r");
    expect(await choosing).toBe(0);
    expect(terminal.modes).toEqual([true, false]);
    expect(
      await invoke(":copy", id, { env: { PATH: home }, stdoutIsTty: true }),
    ).toBe(0);
    expect(output.join("")).toContain("\u001b]52;c;");
  });
  it("reports an unsupported thinking capability and handles backend model metadata without names", async () => {
    await start();
    await invoke(":new");
    const id = directives().conversation!;
    const connect: NonNullable<RunOptions["connect"]> = (options) => {
      const client = new DaemonClient(options);
      const call = client.call.bind(client);
      client.call = async (op, params) => {
        if (op === "thinking.list")
          throw new PrefaixError(
            "UNSUPPORTED",
            ":think isn't supported by this backend",
          );
        return op === "model.list"
          ? ({ models: [{ provider: "fake", id: "fake-fast" }] } as never)
          : call(op, params);
      };
      return client;
    };
    expect(await invoke(":think high", id, { connect })).toBe(2);
    expect(errors.join("")).toContain("isn't supported");
    expect(
      await invoke(":m", id, { connect, picker: async () => undefined }),
    ).toBe(0);
    expect(await invoke(":model fake/fake-fast", id, { connect })).toBe(0);
  });
  it.each([0, 2_000])(
    "does not mutate model settings while another shell owns a turn (metadata pause %ims)",
    async (metadataPauseMs) => {
      await start();
      await invoke(":new");
      const id = directives().conversation!;
      const client = new DaemonClient({ paths, version: "test" });
      await client.connect();
      const terminal = input();
      let entered!: () => void;
      let release!: () => void;
      const running = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prompt = FakeSession.prototype.prompt;
      // Keep a genuinely started fake turn alive until the real abort RPC is
      // acknowledged. Slow metadata/coverage work cannot race natural settle.
      const held = vi
        .spyOn(FakeSession.prototype, "prompt")
        .mockImplementation(async function* (this: FakeSession, input, signal) {
          const iterator = prompt.call(this, input, signal);
          try {
            const first = await iterator.next();
            expect(first.done).toBe(false);
            if (first.done) return;
            yield first.value;
            entered();
            await gate;
            yield* iterator;
          } finally {
            await iterator.return(undefined);
          }
        });
      const pending = invoke(": a long request", id, {
        tty: terminal.tty,
        env: { PATH: "/usr/bin", PREFAIX_FAKE_SCENARIO: "long" },
        connect: (options) => {
          const foreground = new DaemonClient(options);
          const call = foreground.call.bind(foreground);
          foreground.call = async (op, params) => {
            const result = await call(op, params);
            if (op === "turn.abort") release();
            return result as never;
          };
          return foreground;
        },
      });
      try {
        await running;
        expect(
          (
            await client.call<{ state: string }>("status.get", {
              conversationId: id,
            })
          ).state,
        ).toBe("busy");
        await expect(
          client.call("model.set", {
            conversationId: id,
            ref: { provider: "fake", id: "fake-fast" },
          }),
        ).rejects.toThrow(/wait for/u);
        await expect(
          client.call("thinking.set", { conversationId: id, level: "low" }),
        ).rejects.toThrow(/wait for/u);
        // Deliberately outlast the old timer-paced scenario as a regression.
        await new Promise<void>((resolve) =>
          setTimeout(resolve, metadataPauseMs),
        );
        const listed = await client.call<{ models: unknown[] }>("model.list", {
          conversationId: id,
        });
        expect(listed.models.length).toBeGreaterThan(0);
        terminal.send("\u0003");
        expect(await pending).toBe(130);
        expect(terminal.modes).toEqual([true, false]);
      } finally {
        terminal.send("\u0003");
        release();
        await pending;
        held.mockRestore();
        client.close();
      }
    },
  );
  it("handles invalid daemon-side levels and cold status values", async () => {
    await start();
    await invoke(":new topic");
    const id = directives().conversation!;
    const client = new DaemonClient({ paths, version: "test" });
    await client.connect();
    await expect(
      client.call("thinking.set", { conversationId: id, level: "impossible" }),
    ).rejects.toThrow(/unknown thinking level/u);
    expect(
      await client.call("status.get", { conversationId: "invalid" }),
    ).not.toHaveProperty("conversation");
    client.close();
    const file = join(paths.conversationsDir, `${id}.json`);
    const record = JSON.parse(readFileSync(file, "utf8")) as {
      stats: { costUsd: number; lastContextPct: number };
    };
    record.stats.costUsd = 1.25;
    record.stats.lastContextPct = 42;
    writeFileSync(file, JSON.stringify(record));
    await daemon!.stop();
    await start();
    await invoke(":info", id);
    expect(output.join("")).toContain("cost: $1.250");
    expect(output.join("")).toContain("context: 42%");
    writeFileSync(shellHintsFile(paths, "1-1-a"), "null");
    expect(await invoke(":c -")).toBe(2);
    writeFileSync(
      shellHintsFile(paths, "1-1-a"),
      JSON.stringify({
        current: 3,
        previous: false,
        roots: { good: id, bad: 42 },
      }),
    );
    expect(await invoke(":c -")).toBe(2);
  });
  it("never starts a model turn for unknown tight names, even with arguments", async () => {
    await start();
    const calls: string[] = [];
    const connect: NonNullable<RunOptions["connect"]> = (options) => {
      const client = new DaemonClient(options);
      const call = client.call.bind(client);
      client.call = (op, params) => {
        calls.push(op);
        return call(op, params);
      };
      return client;
    };
    for (const text of [
      ":modle gemini",
      ":fix foo",
      ":unknownthing args",
      ":reveiw src",
    ])
      expect(await invoke(text, "", { connect })).toBe(2);
    expect(calls).not.toContain("turn.start");
    expect(errors.join("")).toContain("Did you mean :model?");
    expect(errors.join("")).toContain("Did you mean :review?");
    expect(errors.join("")).toContain("Use :help");
    expect(errors.join("")).not.toContain("Did you mean ?");
    const client = new DaemonClient({ paths, version: "test" });
    await client.connect();
    expect(await client.call("conv.list", {})).toEqual({ conversations: [] });
    client.close();
  });
  it("routes exact backend shorthand and keeps help local using a conversation cache", async () => {
    await start();
    const prompts: string[] = [];
    const connect: NonNullable<RunOptions["connect"]> = (options) => {
      const client = new DaemonClient(options);
      const call = client.call.bind(client);
      client.call = (op, params) => {
        if (op === "turn.start")
          prompts.push((params as { text: string }).text);
        return call(op, params);
      };
      return client;
    };
    expect(await invoke(":review src", "", { connect })).toBe(0);
    const id = directives().conversation!;
    expect(prompts).toEqual(["/skill:review src"]);
    expect(await invoke(":explain file.ts", id, { connect })).toBe(0);
    expect(prompts.at(-1)).toBe("/explain file.ts");
    expect(await invoke(":init-rules", id, { connect })).toBe(0);
    expect(prompts.at(-1)).toBe("/init-rules");
    await daemon!.stop();
    daemon = undefined;
    const noConnect = vi.fn(() => {
      throw new Error("help must stay local");
    });
    expect(await invoke(":help", id, { connect: noConnect })).toBe(0);
    expect(output.join("")).toContain(
      "agent commands (cached for this conversation)",
    );
    expect(output.join("")).toContain(":review — Review the current diff");
    expect(noConnect).not.toHaveBeenCalled();
  });
  it("rejects arguments to tight no-argument commands before any daemon or doctor work", async () => {
    const connect = vi.fn(() => {
      throw new Error("must not connect");
    });
    const doctor = vi.fn(async () => 0 as const);
    for (const name of [
      ":info ignored",
      ":i ignored",
      ":copy ignored",
      ":doctor ignored",
      ":info\nextra",
    ])
      expect(await invoke(name, "", { connect, doctor })).toBe(2);
    expect(connect).not.toHaveBeenCalled();
    expect(doctor).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("does not take arguments");
  });
  it.each([
    { operation: "commands.list", fail: false, suggestion: false },
    { operation: "status.get", fail: true, suggestion: false },
    { operation: "commands.list", fail: false, suggestion: true },
  ] as const)(
    "preserves early and late typeahead through $operation (error=$fail, suggestion=$suggestion)",
    async ({ operation, fail, suggestion }) => {
      await start({ PREFAIX_FAKE_SCENARIO: suggestion ? "buffer" : "hello" });
      const terminal = input();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready: () => void = () => undefined;
      const waiting = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const pending = invoke(": answer", "", {
        tty: terminal.tty,
        connect: (options) => {
          const client = new DaemonClient(options);
          const call = client.call.bind(client);
          client.call = async (op, params) => {
            if (op === "turn.start") {
              terminal.send("early ");
              return call(op, {
                ...(params as object),
                env: { PREFAIX_FAKE_SCENARIO: suggestion ? "buffer" : "hello" },
              });
            }
            if (op === operation) {
              ready();
              await gate;
              if (fail) throw new Error("metadata failed");
            }
            return call(op, params);
          };
          return client;
        },
      });
      await waiting;
      expect(terminal.modes).toEqual([true]);
      terminal.send("late 日本語");
      release();
      expect(await pending).toBe(fail ? 1 : 0);
      expect(directives().buffer).toBe(
        `${suggestion ? "git push --force-with-lease origin main\n" : ""}early late 日本語`,
      );
      expect(terminal.modes).toEqual([true, false]);
    },
  );
  it("captures input arriving while reporting a startup error and restoring the tty", async () => {
    await start();
    const terminal = input();
    const setRawMode = terminal.tty.setRawMode;
    terminal.tty.setRawMode = (raw) => {
      if (!raw) terminal.send(" during restore");
      return setRawMode(raw);
    };
    const exit = await invoke(": answer", "", {
      tty: terminal.tty,
      err: (text) => {
        errors.push(text);
        if (text.includes("startup failed")) terminal.send(" during error");
      },
      connect: (options) => {
        const client = new DaemonClient(options);
        const call = client.call.bind(client);
        client.call = async (op, params) => {
          if (op === "turn.start") {
            terminal.send("before");
            throw new Error("startup failed");
          }
          return call(op, params);
        };
        return client;
      },
    });
    expect(exit).toBe(1);
    expect(directives().buffer).toBe("before during error during restore");
    expect(terminal.modes).toEqual([true, false]);
  });
  it("sanitizes status hints", () => {
    expect(
      statusLabel({
        version: "t",
        pid: 1,
        backend: "fake",
        uptimeMs: 0,
        clients: 0,
        turns: 0,
        children: 0,
        state: "idle\u001b",
        contextPct: null,
      }),
    ).toBe("prefaix · default · idle ");
  });
});
