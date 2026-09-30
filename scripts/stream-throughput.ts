import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decodeDirectives } from "../src/shells/directives.js";

/** Includes real daemon normalization/transport and actual built client rendering. */
export async function measureStreamThroughput(node: string, bin: string) {
  const home = mkdtempSync(join(tmpdir(), "pfx-burst-"));
  const env = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_RUNTIME_DIR: join(home, "run"),
    PREFAIX_BACKEND: "fake",
    PREFAIX_FAKE_SCENARIO: "burst",
    PREFAIX_POOL_SPARE: "false",
    PREFAIX_PLAIN: "1",
  };
  const daemon = spawn(node, [bin, "daemon", "--foreground"], {
    env,
    cwd: home,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  daemon.stderr.on("data", (data: Buffer) => {
    errors += data.toString();
  });
  daemon.on("error", (error) => {
    errors += error.message;
  });
  let active: ChildProcess | undefined;
  const interrupt = () => {
    active?.kill("SIGTERM");
    daemon.kill("SIGTERM");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  async function terminate(child: ChildProcess | undefined) {
    if (
      child === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    const closed = once(child, "close");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const deadline = Date.now() + 10_000;
    while (!errors.includes("listening on")) {
      assert(
        daemon.exitCode === null &&
          daemon.signalCode === null &&
          Date.now() < deadline,
        `Burst daemon failed to start: ${errors}`,
      );
      await delay(10);
    }
    const textEventsPerTurn = 2000;
    const turns = 3;
    const elapsedMs: number[] = [];
    let conversation = "";
    for (let turn = 0; turn < turns; turn++) {
      const directives = join(home, "directives");
      const started = performance.now();
      const child = spawn(
        node,
        [
          bin,
          "run",
          "--shell",
          "zsh",
          "--shell-id",
          "1-1-burst",
          "--nonce",
          "burst",
          "--directives",
          directives,
          "--cwd",
          home,
          "--conversation",
          conversation,
          "--",
          ": throughput",
        ],
        { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] },
      );
      active = child;
      let output = "";
      let error = "";
      child.stdout.on("data", (data: Buffer) => {
        output += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => {
        error += data.toString();
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const [code] = await once(child, "close");
        assert.equal(code, 0, error);
      } finally {
        clearTimeout(timer);
      }
      elapsedMs.push(performance.now() - started);
      active = undefined;
      const expected = Array.from(
        { length: textEventsPerTurn },
        (_, index) => `burst:${String(index)}\n`,
      ).join("");
      assert.equal(
        output,
        expected,
        "Every burst text delta must arrive once, in order, through the renderer.",
      );
      conversation =
        decodeDirectives(readFileSync(directives))?.conversation ?? "";
      assert(conversation.startsWith("c_"));
    }
    await delay(5000);
    const idleRssMb =
      Number(
        execFileSync("ps", ["-o", "rss=", "-p", String(daemon.pid)], {
          encoding: "utf8",
        }).trim(),
      ) / 1024;
    const slowestEventsPerSecond =
      (textEventsPerTurn / Math.max(...elapsedMs)) * 1000;
    return {
      turns,
      textEventsPerTurn,
      normalizedEventsPerTurn: textEventsPerTurn + 4,
      elapsedMs,
      slowestEventsPerSecond,
      idleRssMb,
      method:
        "Three timer-free 2000-delta fake turns through the real built daemon and CLI; exact ordered rendered text checked. Timing includes client startup and turn persistence; idle RSS follows 5 seconds of quiescence.",
    };
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await terminate(active);
    await terminate(daemon);
    rmSync(home, { recursive: true, force: true });
  }
}
