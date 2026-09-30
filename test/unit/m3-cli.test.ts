import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { main } from "../../src/cli/index.js";
import { resolvePaths } from "../../src/core/paths.js";

let home = "";
let output = "";
let errors = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-m3-cli-"));
  output = "";
  errors = "";
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
function options(argv: string[]) {
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    SHELL: "/bin/zsh",
    PATH: "",
    PREFAIX_AGENT_PI_BIN: "/missing-prefaix-pi",
  };
  return {
    argv,
    env,
    paths: resolvePaths({ env, home }),
    version: "0.0.0-test",
    out: (text: string) => {
      output += text;
    },
    err: (text: string) => {
      errors += text;
    },
  };
}

it.each(["zsh", "fish", "bash"])(
  "routes init %s to the packaged shell script with configuration",
  async (shell) => {
    const io = options(["init", shell]);
    mkdirSync(io.paths.configDir, { recursive: true });
    writeFileSync(
      io.paths.configFile,
      '[context]\nrecent_commands = 3\n[ui]\nrprompt = "on"\n',
    );
    expect(await main(io)).toBe(0);
    expect(output).toContain(
      shell === "bash" ? "__prefaix_dispatch" : "__prefaix_accept_line",
    );
    expect(output).toContain("PREFAIX_SHELL_ID");
    expect(output).toContain("__prefaix_limit");
    expect(errors).toBe("");
  },
);

it.each([{ args: [] }, { args: ["tcsh"] }, { args: ["zsh", "extra"] }])(
  "rejects invalid init arguments %j",
  async ({ args }) => {
    expect(await main(options(["init", ...args]))).toBe(2);
    expect(errors).toContain("usage: prefaix init");
    expect(output).toBe("");
  },
);

it("routes setup and uninstall without touching anything outside the specified HOME", async () => {
  expect(await main(options(["setup", "--shell", "zsh", "--yes"]))).toBe(0);
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain(
    "prefaix init zsh",
  );
  expect(await main(options(["uninstall", "--shell", "zsh", "--yes"]))).toBe(0);
  expect(readFileSync(join(home, ".zshrc"), "utf8")).not.toContain(
    "prefaix init",
  );
});

it("runs doctor locally, including through the colon shortcut", async () => {
  expect(await main(options(["doctor"]))).toBe(1);
  expect(output).toContain("pi");
  expect(output).not.toContain("/missing-prefaix-pi");
  output = "";
  const io = options([
    "run",
    "--shell",
    "zsh",
    "--shell-id",
    "1-1-cli",
    "--shell-version",
    "5.9",
    "--nonce",
    "n",
    "--directives",
    join(home, "directives"),
    "--",
    ":doctor",
  ]);
  expect(await main(io)).toBe(1);
  expect(output).toContain("pi");
  expect(errors).not.toContain("daemon");
});

it("rejects extra doctor arguments before probing", async () => {
  expect(await main(options(["doctor", "extra"]))).toBe(2);
  expect(errors).toContain("usage: prefaix doctor");
});

it("classifies custom JavaScript regexes and unusual colon lines without starting a daemon", async () => {
  const io = options(["classify", "--", ": preserve"]);
  mkdirSync(io.paths.configDir, { recursive: true });
  writeFileSync(
    io.paths.configFile,
    "[grammar]\npassthrough = '^:(?= preserve$)'\n",
  );
  expect(await main(io)).toBe(1);
  expect(await main({ ...io, argv: ["classify", "--", ": help me"] })).toBe(0);
  expect(output + errors).toBe("");
  expect(await main(options(["classify"]))).toBe(2);
});
