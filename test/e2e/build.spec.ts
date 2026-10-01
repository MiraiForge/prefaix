import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const source = fileURLToPath(new URL("../../dist/", import.meta.url));
const node = process.execPath.includes("bun") ? "node" : process.execPath;
let installed: string;
let env: NodeJS.ProcessEnv;
let foreground: ChildProcess | undefined;
let daemonPid: number | undefined;
beforeEach(() => {
  installed = mkdtempSync(join(tmpdir(), "pfx-package-"));
  const dist = join(installed, "dist");
  mkdirSync(dist);
  cpSync(source, dist, { recursive: true });
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({ type: "module", version: "0.0.0-artifact" }),
  );
  env = {
    PATH: `${dirname(execFileSync(node, ["-p", "process.execPath"], { encoding: "utf8" }).trim())}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    HOME: installed,
    XDG_CONFIG_HOME: join(installed, "config"),
    XDG_STATE_HOME: join(installed, "state"),
    XDG_RUNTIME_DIR: join(installed, "run"),
  };
});
afterEach(async () => {
  if (daemonPid !== undefined) {
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch {
      /* Already stopped. */
    }
    daemonPid = undefined;
  }
  if (foreground !== undefined) {
    if (foreground.exitCode === null && foreground.signalCode === null) {
      const closed = once(foreground, "close");
      foreground.kill("SIGTERM");
      await closed;
    }
    foreground = undefined;
  }
  rmSync(installed, { recursive: true, force: true });
});
function evaluate(code: string): string {
  return execFileSync(node, ["--input-type=module", "--eval", code], {
    cwd: installed,
    env,
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}
it("runs the installed CLI and lazy chunks without a source tree or node_modules", () => {
  const cli = join(installed, "dist/prefaix.js");
  expect(
    execFileSync(node, [cli, "--version"], { env, encoding: "utf8" }).trim(),
  ).toBe("0.0.0-artifact");
  expect(
    execFileSync(node, [cli, "init", "zsh"], { env, encoding: "utf8" }),
  ).toContain("__prefaix");
});
it("keeps process, crypto, and readline natives unloaded until a feature needs them", () => {
  const url = pathToFileURL(join(installed, "dist/prefaix.js")).href;
  const output = evaluate(
    `await import(${JSON.stringify(url)}); console.log(JSON.stringify(process.moduleLoadList.filter(name => ["NativeModule crypto", "NativeModule child_process", "NativeModule readline", "NativeModule readline/promises"].includes(name))));`,
  );
  expect(JSON.parse(output)).toEqual([]);
});
it("loads the packaged client without the asynchronous filesystem helpers", () => {
  const client = readdirSync(join(installed, "dist")).find((name) =>
    /^run-.*\.js$/u.test(name),
  );
  expect(client).toBeDefined();
  const url = pathToFileURL(join(installed, "dist", client!)).href;
  const output = evaluate(
    `await import(${JSON.stringify(url)}); process.stdout.write(JSON.stringify(process.moduleLoadList.filter(name => name === "NativeModule fs/promises")));`,
  );
  expect(JSON.parse(output)).toEqual([]);
});
it("keeps crypto unloaded when importing the daemon before a store write", () => {
  const daemon = readdirSync(join(installed, "dist")).find((name) =>
    /^daemon-.*\.js$/u.test(name),
  );
  expect(daemon).toBeDefined();
  const url = pathToFileURL(join(installed, "dist", daemon!)).href;
  const output = evaluate(
    `await import(${JSON.stringify(url)}); console.log(JSON.stringify(process.moduleLoadList.filter(name => name === "NativeModule crypto")));`,
  );
  expect(JSON.parse(output)).toEqual([]);
});
it("loads the packaged pi bridge independently of the CLI", () => {
  const url = pathToFileURL(join(installed, "dist/pi-bridge.js")).href;
  expect(
    evaluate(
      `const bridge = await import(${JSON.stringify(url)}); console.log(typeof bridge.default);`,
    ),
  ).toBe("function");
});

it.each(["foreground", "autospawn"] as const)(
  "uses daemon-only memory settings in the installed %s path",
  async (mode) => {
    const cli = join(installed, "dist/prefaix.js");
    env = {
      ...env,
      PREFAIX_BACKEND: "fake",
      PREFAIX_POOL_SPARE: "false",
      PREFAIX_PLAIN: "1",
    };
    if (mode === "foreground") {
      foreground = spawn(node, [cli, "daemon", "--foreground"], {
        env,
        stdio: "ignore",
      });
    } else {
      const text = execFileSync(
        node,
        [
          cli,
          "run",
          "--shell",
          "zsh",
          "--shell-id",
          "1-1-artifact",
          "--nonce",
          "artifact",
          "--directives",
          join(installed, "directives"),
          "--cwd",
          installed,
          "--",
          ": package check",
        ],
        { env, encoding: "utf8", timeout: 10_000 },
      );
      expect(text).toContain("Hello from the fake backend");
    }
    const lock = join(installed, "run/prefaix/daemon.lock");
    const deadline = Date.now() + 10_000;
    while (!existsSync(lock) && Date.now() < deadline) await delay(10);
    daemonPid = Number(readFileSync(lock, "utf8"));
    expect(daemonPid).toBeGreaterThan(0);
    if (foreground !== undefined) expect(daemonPid).toBe(foreground.pid);
    const command = execFileSync(
      "ps",
      ["-o", "command=", "-p", String(daemonPid)],
      { encoding: "utf8" },
    );
    expect(command).toContain("--jitless");
    expect(command).toContain("--max-semi-space-size=1");
    // The re-exec does not leak a global Node setting into clients or pi.
    expect(env["NODE_OPTIONS"]).toBeUndefined();
    expect(
      evaluate("console.log(JSON.stringify(process.execArgv))"),
    ).not.toContain("--jitless");
  },
);
