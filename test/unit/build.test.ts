import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "prefaix-build-"));
  directories.push(directory);
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  return directory;
}

function build(cwd: string) {
  return spawnSync(
    process.execPath,
    [
      join(root, "node_modules/tsup/dist/cli-default.js"),
      "--config",
      join(root, "tsup.config.ts"),
    ],
    { cwd, encoding: "utf8" },
  );
}

describe("application bundles", () => {
  it("skips an empty source tree without manufacturing an application", () => {
    const cwd = workspace();
    mkdirSync(join(cwd, "src"));
    const result = build(cwd);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("No application entry points yet");
    expect(existsSync(join(cwd, "dist"))).toBe(false);
  });

  it("removes stale bundles when the source tree becomes empty", () => {
    const cwd = workspace();
    mkdirSync(join(cwd, "dist"));
    writeFileSync(join(cwd, "dist/prefaix.js"), "obsolete CLI");
    writeFileSync(join(cwd, "dist/pi-bridge.js"), "obsolete bridge");
    const result = build(cwd);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(join(cwd, "dist"))).toBe(false);
  });

  it("builds a standalone foreground module and keeps dispatch initialization lazy", () => {
    const cwd = workspace();
    mkdirSync(join(cwd, "src/cli"), { recursive: true });
    writeFileSync(
      join(cwd, "src/cli/bin.ts"),
      readFileSync(join(root, "src/cli/bin.ts")),
    );
    writeFileSync(
      join(cwd, "src/cli/daemon-runtime.ts"),
      "export function prepareDaemonRuntime() { return undefined; }\n",
    );
    writeFileSync(
      join(cwd, "src/cli/index.ts"),
      'export async function main() { console.log("main fixture"); return 0; }\n',
    );
    writeFileSync(
      join(cwd, "src/cli/foreground-dependency.ts"),
      'console.log("foreground initialized"); export const marker = "foreground fixture";\n',
    );
    writeFileSync(
      join(cwd, "src/cli/run.ts"),
      'import {marker} from "./foreground-dependency.js"; export async function runClient() { console.log(marker); return 0; }\n',
    );
    const result = build(cwd);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(join(cwd, "dist/client.js"))).toBe(true);
    expect(existsSync(join(cwd, "dist/client.js.map"))).toBe(true);
    const invoke = (args: string[]) =>
      spawnSync(process.execPath, [join(cwd, "dist/prefaix.js"), ...args], {
        encoding: "utf8",
      });
    const help = invoke(["--help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout.trim()).toBe("main fixture");
    const run = invoke(["run"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(
      "foreground initialized\nforeground fixture",
    );
    // A wrapper which still imports shared chunks cannot pass this: the
    // foreground entry remains runnable after every other output is removed.
    for (const file of readdirSync(join(cwd, "dist"))) {
      if (file !== "client.js" && file !== "client.js.map")
        rmSync(join(cwd, "dist", file), { force: true });
    }
    const isolated = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const {runClient} = await import("./dist/client.js"); await runClient();',
      ],
      { cwd, encoding: "utf8" },
    );
    expect(isolated.status, isolated.stderr).toBe(0);
    expect(isolated.stdout.trim()).toBe(
      "foreground initialized\nforeground fixture",
    );
  });

  it("builds both named ESM bundles with source maps and preserves the CLI shebang", () => {
    const cwd = workspace();
    mkdirSync(join(cwd, "src/cli"), { recursive: true });
    mkdirSync(join(cwd, "src/agents/pi"), { recursive: true });
    // The bin is the entry the package points at, so the shebang and the
    // runnable bundle are both asserted through it.
    writeFileSync(
      join(cwd, "src/cli/bin.ts"),
      '#!/usr/bin/env node\nconst message: string = "cli fixture"; console.log(message);\n',
    );
    writeFileSync(
      join(cwd, "src/agents/pi/bridge.ts"),
      'export const context: string = "bridge fixture";\n',
    );
    const result = build(cwd);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    for (const name of ["prefaix", "pi-bridge"]) {
      expect(existsSync(join(cwd, `dist/${name}.js`))).toBe(true);
      expect(
        JSON.parse(readFileSync(join(cwd, `dist/${name}.js.map`), "utf8"))
          .sources.length,
      ).toBeGreaterThan(0);
    }
    expect(readFileSync(join(cwd, "dist/prefaix.js"), "utf8")).toMatch(
      /^#!\/usr\/bin\/env node\n/,
    );
    const cli = spawnSync(process.execPath, [join(cwd, "dist/prefaix.js")], {
      encoding: "utf8",
    });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.trim()).toBe("cli fixture");
    const bridge = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { context } from "./dist/pi-bridge.js"; console.log(context);',
      ],
      { cwd, encoding: "utf8" },
    );
    expect(bridge.status, bridge.stderr).toBe(0);
    expect(bridge.stdout.trim()).toBe("bridge fixture");
  });
});
