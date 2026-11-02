import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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

  it("keeps doctor probes out of the foreground bundle but runs them on demand", () => {
    const cwd = workspace();
    for (const directory of ["cli", "core", "client", "agents"])
      mkdirSync(join(cwd, "src", directory), { recursive: true });
    for (const file of ["cli/run.ts", "core/errors.ts"])
      writeFileSync(
        join(cwd, "src", file),
        readFileSync(join(root, "src", file)),
      );
    writeFileSync(
      join(cwd, "src/cli/bin.ts"),
      "export const fixture = true;\n",
    );
    writeFileSync(
      join(cwd, "src/core/paths.ts"),
      "export function resolvePaths() { return {}; }\n",
    );
    writeFileSync(
      join(cwd, "src/client/run.ts"),
      'export async function run(options) { return options.argv[0] === "doctor" ? options.doctor({shell: "zsh", shellVersion: "5"}) : 0; }\n',
    );
    writeFileSync(
      join(cwd, "src/agents/doctor-probe.ts"),
      'import {createHash} from "node:crypto"; export const result = createHash("sha256").update("probe").digest("hex");\n',
    );
    writeFileSync(
      join(cwd, "src/cli/doctor.ts"),
      'import {result} from "../agents/doctor-probe.js"; export function runDoctor(options) { options.out(result); return 0; }\n',
    );
    const result = build(cwd);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(join(cwd, "dist/doctor.js"))).toBe(true);
    const sources = JSON.parse(
      readFileSync(join(cwd, "dist/client.js.map"), "utf8"),
    ).sources as string[];
    expect(sources.some((source) => source.includes("/agents/"))).toBe(false);
    expect(sources.some((source) => source.endsWith("/cli/doctor.ts"))).toBe(
      false,
    );
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const {runClient} = await import("./dist/client.js");
        const output = [];
        const options = {version: "0.0.0", out: value => output.push(value)};
        const ordinary = await runClient({...options, argv: []});
        const before = process.moduleLoadList.includes("NativeModule crypto");
        const doctor = await runClient({...options, argv: ["doctor"]});
        console.log(JSON.stringify({ordinary, doctor, before, output,
          after: process.moduleLoadList.includes("NativeModule crypto")}));`,
      ],
      { cwd, encoding: "utf8" },
    );
    expect(probe.status, probe.stderr).toBe(0);
    const observed = JSON.parse(probe.stdout);
    expect(observed.ordinary).toBe(0);
    expect(observed.doctor).toBe(0);
    expect(observed.before).toBe(false);
    expect(observed.after).toBe(true);
    expect(observed.output).toEqual([
      "ba9c736f19e7f60b7f6764adb0b7908c0a2b394e09b6c09863528c7f2bc86095",
    ]);
  });

  it("runs the real doctor command through the built foreground entry", () => {
    const cwd = workspace();
    cpSync(join(root, "src"), join(cwd, "src"), { recursive: true });
    cpSync(join(root, "package.json"), join(cwd, "package.json"));
    symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
    const result = build(cwd);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const home = join(cwd, "home");
    mkdirSync(home);
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {readFileSync} from "node:fs";
        const {runClient} = await import("./dist/client.js");
        const home = ${JSON.stringify(home)};
        const output = [], errors = [];
        const code = await runClient({
          argv: ["--shell", "zsh", "--shell-version", "5.9", "--shell-id", "probe",
            "--nonce", "doctor-probe", "--directives", home + "/directives", "--", ":doctor"],
          version: "0.0.0", env: {HOME: home, XDG_CONFIG_HOME: home + "/config",
            XDG_STATE_HOME: home + "/state", XDG_RUNTIME_DIR: home + "/runtime", PATH: "",
            PREFAIX_PLUGIN_LOADED: "1"},
          out: text => output.push(text), err: text => errors.push(text),
          connect: () => { throw new Error("doctor must not connect to the daemon"); }
        });
        console.log(JSON.stringify({code, output: output.join(""), errors,
          directives: readFileSync(home + "/directives", "utf8")}));`,
      ],
      { cwd, encoding: "utf8", timeout: 10_000 },
    );
    expect(probe.status, probe.stderr).toBe(0);
    const observed = JSON.parse(probe.stdout);
    // An empty PATH deliberately makes the real backend unavailable, avoiding
    // any installed agent, credentials or model while exercising its imports.
    expect(observed.code).toBe(1);
    expect(observed.output).toContain(
      "pi was not found or could not be inspected.",
    );
    expect(observed.output).toContain(
      "Configuration and PREFAIX overrides are valid.",
    );
    expect(observed.errors).toEqual([]);
    expect(observed.directives).toBe("nonce\0doctor-probe\0");
  });

  it("loads commit-only builtins only when the bundled commit path is called", () => {
    const cwd = workspace();
    const init = spawnSync("git", ["init", "--quiet"], {
      cwd,
      encoding: "utf8",
    });
    expect(init.status, init.stdout + init.stderr).toBe(0);
    for (const directory of ["cli", "core", "context"])
      mkdirSync(join(cwd, "src", directory), { recursive: true });
    for (const file of ["core/errors.ts", "context/staged-diff.ts"])
      writeFileSync(
        join(cwd, "src", file),
        readFileSync(join(root, "src", file)),
      );
    writeFileSync(
      join(cwd, "src/cli/bin.ts"),
      "export const fixture = true;\n",
    );
    writeFileSync(
      join(cwd, "src/cli/run.ts"),
      'export async function runClient() { const {stagedDiff} = await import("../context/staged-diff.js"); return stagedDiff(process.cwd(), {PATH: process.env.PATH}, 0); }\n',
    );
    const result = build(cwd);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const {runClient} = await import("./dist/client.js");
        const modules = () => process.moduleLoadList.filter(name =>
          name === "NativeModule crypto" || name === "NativeModule child_process");
        const before = modules();
        let failure;
        try { await runClient(); } catch (error) { failure = error.code; }
        console.log(JSON.stringify({before, after: modules(), failure}));`,
      ],
      { cwd, encoding: "utf8" },
    );
    expect(probe.status, probe.stderr).toBe(0);
    const observed = JSON.parse(probe.stdout);
    expect(observed.before).toEqual([]);
    expect(observed.after.sort()).toEqual([
      "NativeModule child_process",
      "NativeModule crypto",
    ]);
    expect(observed.failure).toBe("USAGE");
  });

  it("loads picker filesystem promises only for an external selection", () => {
    const cwd = workspace();
    for (const directory of ["cli", "core", "client"])
      mkdirSync(join(cwd, "src", directory), { recursive: true });
    for (const file of [
      "core/errors.ts",
      "client/picker.ts",
      "client/tty.ts",
      "client/process.ts",
    ])
      cpSync(join(root, "src", file), join(cwd, "src", file));
    writeFileSync(
      join(cwd, "src/cli/bin.ts"),
      "export const fixture = true;\n",
    );
    writeFileSync(
      join(cwd, "src/cli/run.ts"),
      'export {pick as runClient} from "../client/picker.js";\n',
    );
    writeFileSync(join(cwd, "fzf"), "#!/bin/sh\nprintf '0\\tfirst\\0'\n", {
      mode: 0o700,
    });
    const result = build(cwd);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const {runClient} = await import("./dist/client.js");
        const loaded = () => process.moduleLoadList.includes("NativeModule fs/promises");
        const before = loaded();
        const selected = await runClient({items: [{id: "selected", label: "first"}],
          title: "probe", mode: "auto", env: {PATH: process.cwd()}, out: () => {}});
        console.log(JSON.stringify({before, selected, after: loaded()}));`,
      ],
      { cwd, encoding: "utf8", timeout: 10_000 },
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({
      before: false,
      selected: "selected",
      after: true,
    });
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
