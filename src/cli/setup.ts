import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import type { ShellKind } from "../core/agent-port.js";
import { EXIT, PrefaixError, type ExitCode } from "../core/errors.js";

export type SetupEnv = Readonly<Record<string, string | undefined>>;
export const SETUP_START = "# >>> prefaix init >>>";
export const SETUP_END = "# <<< prefaix init <<<";
const JOINED = "# prefaix: original file had no final newline";

export interface SetupOptions {
  readonly env?: SetupEnv;
  readonly home?: string;
  readonly out?: (text: string) => void;
  readonly err?: (text: string) => void;
  readonly isTty?: boolean;
  readonly confirm?: (question: string) => Promise<boolean>;
}

export function detectShell(env: SetupEnv): ShellKind | undefined {
  const candidate = env["PREFAIX_SHELL"] || basename(env["SHELL"] ?? "");
  return candidate === "zsh" || candidate === "fish" || candidate === "bash"
    ? candidate
    : undefined;
}

export function shellRcFile(
  shell: ShellKind,
  home: string,
  env: SetupEnv,
): string {
  if (!isAbsolute(home)) {
    throw new PrefaixError("USAGE", "HOME must be an absolute directory.");
  }
  switch (shell) {
    case "zsh": {
      const directory = env["ZDOTDIR"];
      return join(
        directory && isAbsolute(directory) ? directory : home,
        ".zshrc",
      );
    }
    case "fish": {
      const directory = env["XDG_CONFIG_HOME"];
      return join(
        directory && isAbsolute(directory) ? directory : join(home, ".config"),
        "fish/config.fish",
      );
    }
    case "bash":
      return join(home, ".bashrc");
  }
}

export function setupBlock(shell: ShellKind, joined = false): string {
  const init =
    shell === "fish"
      ? "prefaix init fish | source"
      : `eval "$(prefaix init ${shell})"`;
  return `${SETUP_START}\n${joined ? `${JOINED}\n` : ""}${init}\n${SETUP_END}\n`;
}

/** Only an exact block we own can be removed; changed or broken blocks need review. */
export function removeSetupBlock(text: string, shell: ShellKind): string {
  const starts = text.split(SETUP_START).length - 1;
  const ends = text.split(SETUP_END).length - 1;
  if (starts === 0 && ends === 0) return text;
  if (starts !== 1 || ends !== 1) {
    throw new PrefaixError(
      "USAGE",
      "The prefaix rc markers are incomplete or duplicated. Repair the marked block manually first.",
    );
  }
  for (const joined of [false, true]) {
    const block = setupBlock(shell, joined);
    const index = text.indexOf(block);
    if (index !== -1 && (index === 0 || text[index - 1] === "\n")) {
      const suffix = text.slice(index + block.length);
      const start = joined && index > 0 && suffix === "" ? index - 1 : index;
      return text.slice(0, start) + suffix;
    }
  }
  throw new PrefaixError(
    "USAGE",
    "The prefaix rc block has user edits. Remove it manually to preserve those edits.",
  );
}

function readRc(file: string): {
  text: string;
  mode: number;
  exists: boolean;
  target: string;
} {
  try {
    const entry = lstatSync(file);
    const target = entry.isSymbolicLink() ? realpathSync(file) : file;
    const info = lstatSync(target);
    if (!info.isFile()) throw new Error("not a regular file");
    return {
      text: readFileSync(target, "utf8"),
      mode: info.mode & 0o777,
      exists: true,
      target,
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      // A dangling symlink is not an absent file and must not be replaced.
      try {
        if (lstatSync(file).isSymbolicLink())
          throw new Error("dangling symlink", { cause });
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
      }
      return { text: "", mode: 0o600, exists: false, target: file };
    }
    throw cause;
  }
}

async function ask(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return /^(?:y|yes)$/i.test((await input.question(question)).trim());
  } finally {
    input.close();
  }
}

async function changeSetup(
  argv: readonly string[],
  options: SetupOptions,
  uninstall: boolean,
): Promise<ExitCode> {
  const out =
    options.out ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const err =
    options.err ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const action = uninstall ? "uninstall" : "setup";
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        shell: { type: "string" },
        yes: { type: "boolean", short: "y" },
        "dry-run": { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (
      positionals.length > 1 ||
      (positionals.length === 1 && values.shell !== undefined)
    ) {
      throw new PrefaixError(
        "USAGE",
        "Specify one shell using --shell zsh|fish|bash.",
      );
    }
    const env = options.env ?? process.env;
    const requested = values.shell ?? positionals[0] ?? detectShell(env);
    if (requested !== "zsh" && requested !== "fish" && requested !== "bash") {
      throw new PrefaixError(
        "USAGE",
        "Cannot detect a supported shell. Use --shell zsh|fish|bash.",
      );
    }
    const file = shellRcFile(
      requested,
      options.home ?? env["HOME"] ?? homedir(),
      env,
    );
    const before = readRc(file);
    const removed = removeSetupBlock(before.text, requested);
    if (requested === "bash" && !uninstall) {
      out(
        'Bash login shells also need the active login profile to source ~/.bashrc.\nAdd this line to the first existing file among ~/.bash_profile, ~/.bash_login, and ~/.profile (or create ~/.bash_profile):\n[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n',
      );
    }
    if (
      (uninstall && removed === before.text) ||
      (!uninstall && removed !== before.text)
    ) {
      out(
        uninstall
          ? "prefaix is not installed in this rc file.\n"
          : "prefaix is already installed in this rc file.\n",
      );
      return EXIT.ok;
    }
    const separator =
      before.text !== "" && !before.text.endsWith("\n") ? "\n" : "";
    const block = setupBlock(requested, separator !== "");
    const after = uninstall ? removed : before.text + separator + block;
    const changed = uninstall
      ? before.text.slice(
          removed.length === 0 ? 0 : before.text.indexOf(SETUP_START),
          before.text.indexOf(SETUP_END) + SETUP_END.length,
        )
      : block.trimEnd();
    out(
      `--- ${JSON.stringify(file)}\n+++ ${JSON.stringify(file)}\n@@ prefaix ${action} @@\n`,
    );
    out(
      changed
        .split("\n")
        .map((line) => `${uninstall ? "-" : "+"}${line}`)
        .join("\n") + "\n",
    );
    if (values["dry-run"]) return EXIT.ok;
    if (!values.yes) {
      if (!(options.isTty ?? process.stdin.isTTY)) {
        err(
          "No files changed. Review the diff, then rerun with --yes, or use an interactive terminal.\n",
        );
        return EXIT.usage;
      }
      if (
        !(await (options.confirm ?? ask)(`Apply prefaix ${action}? [y/N] `))
      ) {
        out("No files changed.\n");
        return EXIT.ok;
      }
    }
    const current = readRc(file);
    if (
      current.text !== before.text ||
      current.exists !== before.exists ||
      current.target !== before.target ||
      current.mode !== before.mode
    ) {
      throw new PrefaixError(
        "USAGE",
        "The rc file changed while awaiting confirmation. Rerun to review a fresh diff.",
      );
    }
    mkdirSync(dirname(before.target), { recursive: true, mode: 0o700 });
    const { randomUUID } = await import("node:crypto");
    if (before.exists) {
      const backup = `${file}.prefaix-backup-${randomUUID()}`;
      writeFileSync(backup, before.text, { flag: "wx", mode: 0o600 });
      out(`Backup: ${JSON.stringify(backup)}\n`);
    }
    const temporary = `${before.target}.prefaix-${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, after, { flag: "wx", mode: before.mode });
      chmodSync(temporary, before.mode);
      renameSync(temporary, before.target);
    } finally {
      rmSync(temporary, { force: true });
    }
    out(
      uninstall
        ? "Removed prefaix initialization. Restart your shell to unload it.\n"
        : "Installed prefaix initialization. Restart your shell to activate it.\n",
    );
    return EXIT.ok;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) {
      err(
        `prefaix ${action}: Invalid arguments. Use --shell zsh|fish|bash and --yes or --dry-run.\n`,
      );
      return EXIT.usage;
    }
    err(
      `prefaix ${action}: ${cause instanceof PrefaixError ? cause.message : "Could not read or update the rc file. Check its permissions and command arguments."}\n`,
    );
    return cause instanceof PrefaixError ? cause.exitCode : EXIT.agentError;
  }
}

export function runSetup(
  argv: readonly string[],
  options: SetupOptions = {},
): Promise<ExitCode> {
  return changeSetup(argv, options, false);
}

export function runUninstall(
  argv: readonly string[],
  options: SetupOptions = {},
): Promise<ExitCode> {
  return changeSetup(argv, options, true);
}
