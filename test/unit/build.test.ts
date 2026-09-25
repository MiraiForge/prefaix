import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

  it("builds both named ESM bundles with source maps and preserves the CLI shebang", () => {
    const cwd = workspace();
    mkdirSync(join(cwd, "src/cli"), { recursive: true });
    mkdirSync(join(cwd, "src/agents/pi"), { recursive: true });
    writeFileSync(
      join(cwd, "src/cli/index.ts"),
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
