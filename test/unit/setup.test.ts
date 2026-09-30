import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as readline from "node:readline/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectShell,
  removeSetupBlock,
  runSetup,
  runUninstall,
  setupBlock,
  shellRcFile,
  type SetupOptions,
} from "../../src/cli/setup.js";

vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => home,
}));
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

let home: string;
let out: string[];
let err: string[];
let options: SetupOptions;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-setup-"));
  out = [];
  err = [];
  options = {
    home,
    env: { SHELL: "/bin/zsh" },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    isTty: false,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});
function backups(file: string): string[] {
  return readdirSync(dirname(file))
    .filter((name) =>
      name.startsWith(`${file.split("/").at(-1)}.prefaix-backup-`),
    )
    .map((name) => join(dirname(file), name));
}

it("detects all supported shells and respects the invoking-shell marker", () => {
  expect(detectShell({ SHELL: "/opt/bin/fish" })).toBe("fish");
  expect(detectShell({ SHELL: "/bin/bash", PREFAIX_SHELL: "zsh" })).toBe("zsh");
  expect(detectShell({ SHELL: "/bin/bash" })).toBe("bash");
  expect(detectShell({})).toBeUndefined();
  expect(detectShell({ SHELL: "/bin/nu" })).toBeUndefined();
});
it("resolves shell-specific rc paths and ignores relative XDG and ZDOTDIR", () => {
  expect(shellRcFile("zsh", home, { ZDOTDIR: "/dotfiles" })).toBe(
    "/dotfiles/.zshrc",
  );
  expect(shellRcFile("zsh", home, { ZDOTDIR: "relative" })).toBe(
    join(home, ".zshrc"),
  );
  expect(shellRcFile("fish", home, { XDG_CONFIG_HOME: "/config" })).toBe(
    "/config/fish/config.fish",
  );
  expect(shellRcFile("fish", home, { XDG_CONFIG_HOME: "relative" })).toBe(
    join(home, ".config/fish/config.fish"),
  );
  expect(() => shellRcFile("bash", "relative", {})).toThrow("absolute");
});

describe.each(["zsh", "fish", "bash"] as const)("%s setup", (shell) => {
  it.each(["", "# personal setting\n", "# without newline"])(
    "installs and exactly reverses %j",
    async (original) => {
      const file = shellRcFile(shell, home, {});
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, original, { mode: 0o640 });
      expect(await runSetup(["--shell", shell, "--yes"], options)).toBe(0);
      const installed = readFileSync(file, "utf8");
      expect(installed).toContain(
        setupBlock(shell, original !== "" && !original.endsWith("\n")),
      );
      expect(lstatSync(file).mode & 0o777).toBe(0o640);
      expect(backups(file)).toHaveLength(1);
      expect(readFileSync(backups(file)[0]!, "utf8")).toBe(original);
      expect(lstatSync(backups(file)[0]!).mode & 0o777).toBe(0o600);
      expect(out.join("")).toContain("@@ prefaix setup @@");
      expect(await runSetup([shell, "-y"], options)).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(installed);
      expect(backups(file)).toHaveLength(1);
      expect(await runUninstall([shell, "--yes"], options)).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(original);
      expect(await runUninstall([shell, "--yes"], options)).toBe(0);
      expect(backups(file)).toHaveLength(2);
    },
  );
  it("creates an absent rc file and preserves outside user additions on uninstall", async () => {
    const file = shellRcFile(shell, home, {});
    expect(await runSetup([shell, "--yes"], options)).toBe(0);
    expect(backups(file)).toHaveLength(0);
    writeFileSync(
      file,
      "# before\n" + readFileSync(file, "utf8") + "# after\n",
    );
    expect(await runUninstall([shell, "--yes"], options)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("# before\n# after\n");
  });
});
it("shows a diff without writing during a dry run", async () => {
  expect(await runSetup(["--dry-run"], options)).toBe(0);
  expect(out.join("")).toContain('+eval "$(prefaix init zsh)"');
  expect(readdirSync(home)).toEqual([]);
});
it("explains login-profile sourcing for bash previews, installs, and repeated setup", async () => {
  for (const flags of [["--dry-run"], ["--yes"], ["--yes"]]) {
    out = [];
    expect(await runSetup(["--shell", "bash", ...flags], options)).toBe(0);
    const printed = out.join("");
    expect(printed).toContain("Bash login shells");
    expect(printed).toContain("~/.bash_profile, ~/.bash_login, and ~/.profile");
    expect(printed).toContain('[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"');
  }
  expect(readdirSync(home)).toEqual([".bashrc"]);
});
it("requires explicit confirmation when not interactive", async () => {
  expect(await runSetup([], options)).toBe(2);
  expect(err.join("")).toContain("--yes");
  expect(readdirSync(home)).toEqual([]);
});
it("leaves files alone when confirmation is declined", async () => {
  const confirm = vi.fn().mockResolvedValue(false);
  expect(await runSetup([], { ...options, isTty: true, confirm })).toBe(0);
  expect(confirm).toHaveBeenCalledWith("Apply prefaix setup? [y/N] ");
  expect(readdirSync(home)).toEqual([]);
});
it("applies a reviewed diff after interactive confirmation", async () => {
  expect(
    await runSetup([], { ...options, isTty: true, confirm: async () => true }),
  ).toBe(0);
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe(setupBlock("zsh"));
});
it("uses readline for default interactive confirmation and closes it", async () => {
  const close = vi.fn();
  const question = vi.fn().mockResolvedValue(" YES ");
  vi.mocked(readline.createInterface).mockReturnValue({
    question,
    close,
  } as unknown as readline.Interface);
  expect(await runSetup([], { ...options, isTty: true })).toBe(0);
  expect(close).toHaveBeenCalled();
});
it("does not overwrite a file changed during confirmation", async () => {
  const file = join(home, ".zshrc");
  expect(
    await runSetup([], {
      ...options,
      isTty: true,
      confirm: async () => {
        writeFileSync(file, "# concurrent edit\n");
        return true;
      },
    }),
  ).toBe(2);
  expect(readFileSync(file, "utf8")).toBe("# concurrent edit\n");
  expect(err.join("")).toContain("changed while");
});
it("preserves rc symlinks while updating and backing up their target", async () => {
  const target = join(home, "tracked-rc");
  const file = join(home, ".zshrc");
  writeFileSync(target, "# dotfile\n");
  symlinkSync(target, file);
  expect(await runSetup(["--yes"], options)).toBe(0);
  expect(lstatSync(file).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toContain(setupBlock("zsh"));
  expect(await runUninstall(["--yes"], options)).toBe(0);
  expect(readFileSync(target, "utf8")).toBe("# dotfile\n");
});
it.each(["dangling", "directory"])(
  "does not replace a %s rc file",
  async (kind) => {
    const file = join(home, ".zshrc");
    if (kind === "dangling") symlinkSync(join(home, "absent"), file);
    else mkdirSync(file);
    expect(await runSetup(["--yes"], options)).toBe(1);
    expect(err.join("")).toContain("Could not read or update");
  },
);
it.each([
  "# >>> prefaix init >>>\n",
  setupBlock("zsh") + setupBlock("zsh"),
  setupBlock("zsh").replace("eval", "# personal edit\neval"),
  "prefix" + setupBlock("zsh"),
])("preserves incomplete, duplicate, or modified markers", async (contents) => {
  const file = join(home, ".zshrc");
  writeFileSync(file, contents);
  expect(await runUninstall(["--yes"], options)).toBe(2);
  expect(readFileSync(file, "utf8")).toBe(contents);
  expect(backups(file)).toHaveLength(0);
});
it("removes a joined block even if manually moved to the start", () => {
  expect(removeSetupBlock(setupBlock("zsh", true), "zsh")).toBe("");
});
it.each([
  ["--shell", "nu"],
  ["zsh", "bash"],
  ["zsh", "--shell", "bash"],
])("rejects invalid shell arguments %j", async (...args) => {
  expect(await runSetup(args, options)).toBe(2);
});
it("rejects unknown flags without touching files", async () => {
  expect(await runSetup(["--bogus"], options)).toBe(2);
});
it("uses HOME and the detected shell from the supplied environment", async () => {
  expect(
    await runSetup(["--yes"], {
      ...options,
      home: undefined,
    } as unknown as SetupOptions),
  ).toBe(0);
});
it("uses standard streams and process env when options are omitted", async () => {
  vi.stubEnv("HOME", home);
  vi.stubEnv("SHELL", "/bin/zsh");
  vi.stubEnv("PREFAIX_SHELL", "zsh");
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    expect(await runSetup(["--yes"])).toBe(0);
    expect(await runUninstall(["--yes"])).toBe(0);
    expect(await runSetup(["--shell", "nu"])).toBe(2);
    expect(stdout).toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});
it("checks mode changes during confirmation", async () => {
  const file = join(home, ".zshrc");
  writeFileSync(file, "", { mode: 0o600 });
  expect(
    await runSetup([], {
      ...options,
      isTty: true,
      confirm: async () => {
        chmodSync(file, 0o644);
        return true;
      },
    }),
  ).toBe(2);
});

it("retains a separating newline for later edits after an originally unterminated line", async () => {
  const file = join(home, ".zshrc");
  writeFileSync(file, "export ORIGINAL=1");
  await runSetup(["--yes"], options);
  writeFileSync(file, readFileSync(file, "utf8") + "export LATER=2\n");
  await runUninstall(["--yes"], options);
  expect(readFileSync(file, "utf8")).toBe(
    "export ORIGINAL=1\nexport LATER=2\n",
  );
});
it("uses the safe mocked homedir fallback when HOME is missing", async () => {
  expect(
    await runSetup(["zsh", "--yes"], { env: {}, out: () => {}, err: () => {} }),
  ).toBe(0);
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe(setupBlock("zsh"));
});
