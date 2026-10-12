import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/core/config/schema.js";
import { resolvePaths } from "../../src/core/paths.js";
import { FakeSession } from "../../src/agents/fake/adapter.js";
import { Daemon } from "../../src/daemon/daemon.js";
import { initShell } from "../../src/shells/plugins/index.js";
import { ShellSession, TEST_SHELLS } from "./harness.js";

const BIN = fileURLToPath(new URL("../../dist/prefaix.js", import.meta.url));
let home = "";
let daemon: Daemon | undefined;
let shell: ShellSession | undefined;
let finish = () => {};
let fail = false;
afterEach(async () => {
  finish();
  await shell?.close();
  shell = undefined;
  await daemon?.stop();
  daemon = undefined;
  vi.restoreAllMocks();
  if (home) rmSync(home, { force: true, recursive: true });
});
async function start(kind: (typeof TEST_SHELLS)[number]) {
  home = mkdtempSync(join(tmpdir(), "pfx-detach-e2e-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "prefaix"),
    `#!/bin/sh\nexec '${process.execPath}' '${BIN}' "$@"\n`,
    { mode: 0o700 },
  );
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "run"),
    PATH: `${bin}:${process.env.PATH}`,
    PREFAIX_BACKEND: "fake",
  };
  const paths = resolvePaths({ home, env });
  const config = structuredClone(defaultConfig());
  config.agent.backend = "fake";
  config.pool.spare = false;
  config.ui.rprompt = "on";
  mkdirSync(join(home, "config", "prefaix"), { recursive: true });
  writeFileSync(paths.configFile, '[ui]\nrprompt = "on"\n');
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  fail = false;
  vi.spyOn(FakeSession.prototype, "prompt").mockImplementation(
    async function* (_input, signal) {
      yield { type: "turn_start" };
      yield { type: "text_delta", block: 0, text: "detachable-before\n" };
      let abort!: () => void;
      const cancelled = new Promise<void>((resolve) => {
        abort = resolve;
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (!signal.aborted) await Promise.race([wait, cancelled]);
        if (signal.aborted) {
          yield { type: "settled", stopReason: "aborted" };
          return;
        }
        yield { type: "text_delta", block: 0, text: "detachable-after\n" };
        yield { type: "text_end", block: 0 };
        yield fail
          ? {
              type: "settled",
              stopReason: "error",
              error: "detached scripted error",
            }
          : { type: "settled", stopReason: "stop" };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  );
  daemon = new Daemon({
    paths,
    config,
    env,
    version: "0.0.0",
    checkOwner: false,
  });
  await daemon.start();
  // Bash documents a PS1 fallback; its precmd hook populates this variable using builtins.
  const prompt = kind === "bash" ? "\nPS1='__pfx ${PREFAIX_STATUS} '\n" : "";
  shell = await ShellSession.start({
    shell: kind,
    env,
    cwd: home,
    initScript: initShell(kind, { paths, config }) + prompt,
    timeoutMs: 20000,
    promptPattern: /^__pfx(?:\s+(?:⟳.*|✓.*|✗.*|prefaix.*))?$/u,
  });
  return shell;
}
async function detach(s: ShellSession) {
  const row = s.promptRow();
  s.sendLine(": do the work");
  await s.waitFor("detachable-before");
  s.send("\u001a");
  await s.waitForPrompt({ afterRow: row });
  expect(s.screenText()).toContain("⟳ running");
  const id = await s.readVariable("PREFAIX_CONVERSATION_ID");
  expect(daemon!.turns.runningFor(id)?.owner).toBe("detached");
  return id;
}
async function completed(id: string) {
  await vi.waitFor(() =>
    expect(daemon!.turns.lastFor(id)?.finished).toBe(true),
  );
}
async function command(s: ShellSession, text: string) {
  const row = s.promptRow();
  s.sendLine(text);
  await s.waitForPrompt({ afterRow: row });
}
describe.each(TEST_SHELLS)("%s detach/attach shell flow", (kind) => {
  it("detaches without a stopped job, permits normal shell commands, replays and follows, and restores tty state", async () => {
    const s = await start(kind);
    const tty = await s.run("stty -g");
    const id = await detach(s);
    expect(await s.run("ls > /dev/null; echo shell-is-free")).toBe(
      "shell-is-free",
    );
    expect(await s.run("jobs")).not.toContain("Stopped");
    expect(await s.run("stty -g")).toBe(tty);
    const row = s.promptRow();
    s.sendLine(":attach");
    await vi.waitFor(() =>
      expect(daemon!.turns.runningFor(id)?.owner).toBe("attached"),
    );
    finish();
    await s.waitForPrompt({ afterRow: row });
    expect(s.screenText()).toContain("detachable-after");
    expect(s.raw().match(/detachable-before/g)).toHaveLength(2);
    expect(s.raw().match(/detachable-after/g)).toHaveLength(1);
    expect(await s.run("stty -g")).toBe(tty);
    expect(await s.run("echo alive")).toBe("alive");
  });
  it("publishes done on the next normal prompt draw and replays the whole finished turn", async () => {
    const s = await start(kind);
    const id = await detach(s);
    finish();
    await completed(id);
    expect(await s.run("echo redraw")).toBe("redraw");
    expect(
      s
        .screen()
        .filter((row) => row.trim().startsWith("__pfx"))
        .at(-1),
    ).toContain("✓ done");
    expect(await s.readVariable("PREFAIX_STATUS")).toBe("✓ done");
    await command(s, ":attach");
    expect(s.raw().match(/detachable-before/g)).toHaveLength(2);
    expect(s.raw().match(/detachable-after/g)).toHaveLength(1);
  });
  it("supports detaching an attached stream again, then aborting it from the shell", async () => {
    const s = await start(kind);
    const id = await detach(s);
    const row = s.promptRow();
    s.sendLine(":attach");
    await vi.waitFor(() =>
      expect(daemon!.turns.runningFor(id)?.owner).toBe("attached"),
    );
    s.send("\u001a");
    await s.waitForPrompt({ afterRow: row });
    expect(daemon!.turns.runningFor(id)?.owner).toBe("detached");
    await command(s, ":abort");
    await completed(id);
    expect(daemon!.turns.lastFor(id)?.summary?.status).toBe("aborted");
    await command(s, ":attach");
    expect(s.screenText()).toContain("aborted");
    expect(s.raw()).not.toContain("detachable-after");
    expect(await s.run("echo alive")).toBe("alive");
  });
  it("publishes background failure without another prefaix command", async () => {
    const s = await start(kind);
    const id = await detach(s);
    fail = true;
    finish();
    await completed(id);
    await s.run("echo redraw");
    expect(await s.readVariable("PREFAIX_STATUS")).toBe("✗ error");
    await command(s, ":attach");
    expect(s.screenText()).toContain("detached scripted error");
  });
});
