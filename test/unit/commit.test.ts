import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Daemon } from "../../src/daemon/daemon.js";
import { DaemonClient } from "../../src/client/connection.js";
import { run, type RunOptions } from "../../src/client/run.js";
import { FakeSession } from "../../src/agents/fake/adapter.js";
import { defaultConfig } from "../../src/core/config/schema.js";
import { resolvePaths } from "../../src/core/paths.js";
import { decodeDirectives } from "../../src/shells/directives.js";
import { commitCommand } from "../../src/core/commit-proposal.js";
import type { AgentEvent } from "../../src/core/agent-port.js";

let home: string;
let daemon: Daemon;
let env: Record<string, string>;
let output: string[];
let config: ReturnType<typeof defaultConfig>;
let paths: ReturnType<typeof resolvePaths>;
function git(...args: string[]) {
  return execFileSync("git", args, { cwd: home, env, encoding: "utf8" });
}
function stage(text = "hello\n") {
  writeFileSync(join(home, "file"), text);
  git("add", "file");
}
function directives() {
  return decodeDirectives(readFileSync(join(home, "directives")))!;
}
function active() {
  return daemon.pool.session(directives().conversation!) as FakeSession;
}
async function invoke(
  line = ":commit",
  conversation = "",
  options: Partial<RunOptions> = {},
) {
  return run({
    argv: [
      "--shell",
      "bash",
      "--shell-id",
      "1-1-b",
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
      "--",
      line,
    ],
    version: "test",
    config,
    paths,
    env,
    out: (text) => output.push(text),
    err: (text) => output.push(text),
    tty: { setRawMode: () => true, on: () => {}, removeAllListeners: () => {} },
    stdoutIsTty: false,
    ...options,
  });
}
beforeEach(async () => {
  config = structuredClone(defaultConfig());
  config.agent.backend = "fake";
  config.pool.spare = false;
  home = mkdtempSync(join(tmpdir(), "pfx-commit-"));
  output = [];
  env = {
    HOME: home,
    PATH: process.env.PATH!,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  paths = resolvePaths({
    home,
    env: { ...env, XDG_RUNTIME_DIR: join(home, "run") },
  });
  git("init", "--quiet");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  daemon = new Daemon({
    paths,
    config,
    env,
    version: "test",
    checkOwner: false,
  });
  await daemon.start();
});
afterEach(async () => {
  await daemon.stop();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});
it("routes a dedicated commit edit, supplies staged data and style, and never runs by default", async () => {
  stage();
  const calls: string[] = [];
  expect(
    await invoke(":commit add greeting", "", {
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
    output.join(""),
  ).toBe(0);
  expect(calls).toContain("turn.commit");
  expect(calls).not.toContain("turn.start");
  expect(directives().buffer).toBe(
    commitCommand("feat: draft staged changes", "bash"),
  );
  expect(active().lastPrompt).toMatchObject({
    commandProposal: true,
    commitStyle: config.commands.commit.style,
  });
  expect(active().lastPrompt?.text).toContain('"hint":"add greeting"');
  expect(active().lastPrompt?.text).toContain("+hello");
  expect(git("diff", "--cached")).toContain("+hello");
});
it("reports an empty stage without sending a prompt or returning a buffer", async () => {
  const prompt = vi.spyOn(FakeSession.prototype, "prompt");
  expect(await invoke()).toBe(1);
  expect(output.join("")).toContain("no staged changes");
  expect(prompt).not.toHaveBeenCalled();
  expect(directives().buffer).toBeUndefined();
});
it("reports capped diffs and forwards Conventional Commit configuration", async () => {
  config.commands.commit.maxDiffBytes = 24;
  config.commands.commit.style = "Conventional Commits: type(scope): subject";
  stage("x".repeat(1000));
  expect(await invoke(), output.join("")).toBe(0);
  expect(output.join("")).toContain("staged diff truncated to 24 bytes");
  expect(active().lastPrompt?.commitStyle).toContain("Conventional Commits");
  const data = JSON.parse(
    active().lastPrompt!.text.split("\n").slice(1).join("\n"),
  ) as { stagedDiff: string; truncated: boolean };
  expect(Buffer.byteLength(data.stagedDiff)).toBe(24);
  expect(data.truncated).toBe(true);
});
it("--run commits directly only after successful finalization and never restores the command buffer", async () => {
  stage();
  expect(await invoke(":commit --run greeting")).toBe(0);
  expect(git("log", "-1", "--format=%s").trim()).toBe(
    "feat: draft staged changes",
  );
  expect(directives().buffer).toBeUndefined();
  expect(output.join("")).toContain("file changed");
});
it("refuses --run after metadata failure or a changed index", async () => {
  stage();
  expect(await invoke(": hello")).toBe(0);
  const id = directives().conversation!;
  vi.spyOn(active(), "prompt").mockImplementation(async function* () {
    stage("changed\n");
    yield { type: "set_buffer", text: commitCommand("msg", "bash") };
    yield { type: "settled", stopReason: "stop" };
  });
  expect(await invoke(":commit --run", id)).toBe(2);
  expect(output.join("")).toContain("changed while drafting");
  expect(directives().buffer).toBeUndefined();
  expect(
    await invoke(":commit --run", id, {
      connect: (options) => {
        const client = new DaemonClient(options);
        const call = client.call.bind(client);
        client.call = async (op, params) => {
          if (op === "conv.select") throw new Error("metadata failed");
          return call(op, params);
        };
        return client;
      },
    }),
  ).toBe(1);
  expect(output.join("")).toContain("metadata failed");
  expect(git("diff", "--cached")).toContain("+changed");
});
it.each([
  [
    { type: "set_buffer", text: "touch sentinel" },
    { type: "settled", stopReason: "stop" },
  ],
  [
    { type: "set_buffer", text: commitCommand("msg", "bash") },
    { type: "settled", stopReason: "error" },
  ],
  [
    { type: "set_buffer", text: commitCommand("msg", "bash") },
    { type: "set_buffer", text: commitCommand("two", "bash") },
    { type: "settled", stopReason: "stop" },
  ],
] as AgentEvent[][])(
  "withdraws malformed, failed, or duplicate commit proposals",
  async (...events) => {
    stage();
    expect(await invoke(": hello")).toBe(0);
    const id = directives().conversation!;
    vi.spyOn(active(), "prompt").mockImplementation(async function* () {
      yield* events;
    });
    expect(await invoke(":commit --run", id)).toBe(1);
    expect(directives().buffer).toBeUndefined();
    expect(git("diff", "--cached")).toContain("+hello");
  },
);
it.each(["missing-hash", "invalid-command"])(
  "refuses an invalid final --run summary: %s",
  async (failure) => {
    stage();
    expect(
      await invoke(":commit --run", "", {
        connect: (options) => {
          const client = new DaemonClient(options);
          const onEnd = client.onTurnEnd.bind(client);
          client.onTurnEnd = (listener) =>
            onEnd((id, summary) => {
              const altered = { ...summary };
              if (failure === "missing-hash") delete altered.stagedDiffHash;
              else altered.buffer = "touch sentinel";
              listener(id, altered);
            });
          return client;
        },
      }),
    ).toBe(1);
    expect(output.join("")).toContain("no valid message or index snapshot");
    expect(directives().buffer).toBeUndefined();
    expect(git("diff", "--cached")).toContain("+hello");
  },
);
it("cancellation withdraws a commit without running Git", async () => {
  stage();
  expect(await invoke(": hello")).toBe(0);
  const id = directives().conversation!;
  let send: ((text: string) => void) | undefined;
  vi.spyOn(active(), "prompt").mockImplementation(
    async function* (_input, signal) {
      yield { type: "set_buffer", text: commitCommand("msg", "bash") };
      send!("\u0003");
      expect(signal.aborted).toBe(true);
      yield { type: "settled", stopReason: "stop" };
    },
  );
  expect(
    await invoke(":commit --run", id, {
      tty: {
        setRawMode: () => true,
        on: (_event, listener) => {
          send = listener;
        },
        removeAllListeners: () => {},
      },
    }),
  ).toBe(130);
  expect(directives().buffer).toBeUndefined();
  expect(git("diff", "--cached")).toContain("+hello");
});

it("surfaces a git hook failure without placing an auto-executing retry in the buffer", async () => {
  stage();
  writeFileSync(
    join(home, ".git", "hooks", "pre-commit"),
    "#!/bin/sh\necho refused >&2\nexit 1\n",
    { mode: 0o700 },
  );
  expect(await invoke(":commit --run")).toBe(1);
  expect(output.join("")).toContain("refused");
  expect(directives().status).toBe("prefaix · error");
  expect(directives().buffer).toBeUndefined();
});
