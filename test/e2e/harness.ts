// The shell end-to-end harness (DESIGN §12.3): a real shell in a real pty,
// driven through @xterm/headless, asserted on the rendered screen plus the
// side effects a user would notice.
//
// Every shell starts with no user configuration of its own and one file this
// harness writes, which is where the prefaix plugin goes once it exists. A
// test types keys and waits for screen conditions; nothing is asserted on raw
// output, because raw output is not what a user sees.

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import headless from "@xterm/headless";
import type { ITerminalOptions } from "@xterm/headless";

// node-pty is CommonJS with a native binding, so Node's own resolution is used
// rather than the bundler's.
const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");

const { Terminal } = headless as unknown as {
  Terminal: new (options: ITerminalOptions) => HeadlessTerminal;
};

interface HeadlessTerminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  buffer: {
    active: {
      baseY: number;
      cursorY: number;
      length: number;
      getLine(
        y: number,
      ): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  dispose(): void;
}

export type ShellKind = "zsh" | "fish" | "bash";

export const SHELL_KINDS: readonly ShellKind[] = ["zsh", "fish", "bash"];

interface ShellSpec {
  readonly bin: string;
  readonly args: (rcFile: string) => string[];
  readonly env: (rcFile: string) => Record<string, string>;
  /** The file the shell sources at startup, named as that shell looks for it. */
  readonly rcSource: string;
}

// Where each shell usually lives, used only after a PATH lookup fails. fish in
// particular is often a Homebrew install rather than /usr/bin/fish.
const WELL_KNOWN: Record<ShellKind, string[]> = {
  zsh: ["/bin/zsh", "/usr/bin/zsh"],
  bash: ["/bin/bash", "/usr/bin/bash"],
  fish: ["/usr/bin/fish", "/opt/homebrew/bin/fish", "/usr/local/bin/fish"],
};

/** Pulls a marker value out of command output, or an empty string. */
function readMarker(output: string, marker: string): string {
  for (const line of output.split("\n")) {
    const at = line.indexOf(marker);
    if (at !== -1) {
      return line.slice(at + marker.length).trim();
    }
  }
  return "";
}

export function resolveShellBin(shell: ShellKind): string {
  const name = shell;
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (dir === "") {
      continue;
    }
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  for (const candidate of WELL_KNOWN[shell]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `${shell} is not installed, so its prefaix gates cannot run. Tried PATH ` +
      `and ${WELL_KNOWN[shell].join(", ")}.`,
  );
}

const SHELLS: Record<ShellKind, ShellSpec> = {
  zsh: {
    bin: "",
    // -d skips the system rc files, which on a package-installed zsh run
    // compinit and can ask the user a question the harness never answers, while
    // ZDOTDIR still supplies the harness's own rc.
    args: () => ["-d", "-i"],
    env: () => ({}),
    rcSource: ".zshrc",
  },
  bash: {
    // --rcfile replaces ~/.bashrc; --norc is not combined with it.
    bin: "",
    args: (rcFile) => ["--rcfile", rcFile, "-i"],
    env: () => ({}),
    rcSource: ".bashrc",
  },
  fish: {
    // --no-config skips the user's config.fish; --init-command sources ours.
    bin: "",
    args: (rcFile) => ["--no-config", "--init-command", `source ${rcFile}`],
    env: () => ({}),
    rcSource: "config.fish",
  },
};

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

export interface SessionOptions {
  readonly shell: ShellKind;
  /** Written into the shell's startup file; where the plugin goes. */
  readonly initScript?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
  /** Overrides the shell binary, for a shell that is somewhere else. */
  readonly bin?: string;
}

// node-pty's prebuilt spawn-helper ships without its executable bit, and the
// package's own install scripts do not restore it, so a spawn fails with
// "posix_spawnp failed". Fixing it here keeps the failure legible on any
// machine rather than surfacing as a mysterious pty error.
export function ensureSpawnHelper(): void {
  const root = join(process.cwd(), "node_modules", "node-pty", "prebuilds");
  const dir = join(root, `${process.platform}-${process.arch}`);
  for (const name of ["spawn-helper", "pty.node"]) {
    const file = join(dir, name);
    if (existsSync(file) && (statSync(file).mode & 0o111) === 0) {
      chmodSync(file, 0o755);
    }
  }
}

const PROMPT = "__pfx";

/** A shell that cannot be driven in a pty on this machine. */
export class ShellUnavailableError extends Error {
  override readonly name = "ShellUnavailableError";
}

export interface ShellAvailability {
  readonly shell: ShellKind;
  readonly available: boolean;
  readonly reason?: string;
}

/**
 * Whether a shell can be driven in a pty here. Some shell versions query the
 * terminal at startup and give up when a pty does not answer in exactly the
 * shape they expect; that is an environment fact, so it is detected and
 * reported rather than turned into a failing gate.
 */
export async function probeShell(
  shell: ShellKind,
  options: { timeoutMs?: number } = {},
): Promise<ShellAvailability> {
  try {
    const session = await ShellSession.start({
      shell,
      timeoutMs: options.timeoutMs ?? 5_000,
    });
    session.close();
    return { shell, available: true };
  } catch (error) {
    if (error instanceof ShellUnavailableError) {
      return { shell, available: false, reason: error.message };
    }
    return {
      shell,
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export class ShellSession {
  readonly #terminal: HeadlessTerminal;
  readonly #child: ReturnType<typeof pty.spawn>;
  readonly #dir: string;
  readonly #shell: ShellKind;
  readonly #timeoutMs: number;
  #closed = false;
  #output = "";
  #tokens = 0;

  private constructor(
    terminal: HeadlessTerminal,
    child: ReturnType<typeof pty.spawn>,
    dir: string,
    shell: ShellKind,
    timeoutMs: number,
  ) {
    this.#terminal = terminal;
    this.#child = child;
    this.#dir = dir;
    this.#shell = shell;
    this.#timeoutMs = timeoutMs;
  }

  static async start(options: SessionOptions): Promise<ShellSession> {
    ensureSpawnHelper();
    const spec = SHELLS[options.shell];
    const bin = options.bin ?? resolveShellBin(options.shell);
    const dir = mkdtempSync(join(tmpdir(), `pfx-${options.shell}-`));
    const rcFile = join(dir, spec.rcSource);
    writeFileSync(
      rcFile,
      [
        // A unique, unmistakable prompt, so a wait for it is exact.
        ...promptFor(options.shell),
        options.initScript ?? "",
      ].join("\n"),
      "utf8",
    );

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...spec.env(rcFile),
      ...(options.env ?? {}),
      TERM: "xterm-256color",
    };
    if (options.shell === "zsh") {
      // ZDOTDIR replaces the user's .zshrc rather than disabling rc files.
      env["ZDOTDIR"] = dir;
    }

    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    // Size is a resize, not an option: the public API only takes scrollback
    // and friends at construction.
    const terminal = new Terminal({
      allowProposedApi: true,
      scrollback: 1_000,
    } satisfies ITerminalOptions);
    terminal.resize(cols, rows);

    const child = pty.spawn(bin, spec.args(rcFile), {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd ?? dir,
      env,
    });

    const session = new ShellSession(
      terminal,
      child,
      dir,
      options.shell,
      options.timeoutMs ?? 8_000,
    );
    child.onData((data: string) => {
      session.#output += data;
      terminal.write(data);
      // A real terminal answers the shell's capability queries, and a shell
      // that gets no answer can give up: fish exits on an unanswered cursor
      // position request. Answering is part of emulating a terminal, not a
      // special case for one shell.
      for (const reply of answerQueries(data, terminal)) {
        child.write(reply);
      }
    });
    try {
      // Readiness waits for the prompt, which is the one thing a shell paints
      // before it will read anything. Sending a probe instead would race the
      // shell's own first read and the two would land on one line. Completion,
      // where the shells differ, uses a token instead.
      await session.waitForPrompt({ timeoutMs: options.timeoutMs ?? 8_000 });
    } catch {
      const raw = session.raw();
      session.close();
      // A shell that never reached a prompt cannot be driven here, and saying
      // so precisely beats a bare timeout in a suite log.
      throw new ShellUnavailableError(
        raw.trim() === ""
          ? `${options.shell} produced no prompt and no output in a pty (at ${bin})`
          : `${options.shell} wrote ${String(raw.length)} bytes to the pty but ` +
              `never reached a prompt, so it cannot be driven here; first bytes: ` +
              `${JSON.stringify(raw.slice(0, 80))}`,
      );
    }
    return session;
  }

  /** The visible screen, one string per row, as a user would see it. */
  screen(): string[] {
    const buffer = this.#terminal.buffer.active;
    const rows: string[] = [];
    for (let y = 0; y < DEFAULT_ROWS; y++) {
      rows.push(
        this.#terminal.buffer.active
          .getLine(buffer.baseY + y)
          ?.translateToString(true) ?? "",
      );
    }
    return rows;
  }

  screenText(): string {
    return this.screen().join("\n").trimEnd();
  }

  /** Everything the shell has written, including what scrolled off. */
  raw(): string {
    return this.#output;
  }

  send(text: string): void {
    if (this.#closed) {
      throw new Error("session is closed");
    }
    this.#child.write(text);
  }

  sendLine(text: string): void {
    this.send(`${text}\r`);
  }

  async waitFor(
    needle: string,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    await this.#waitFor(
      () => this.screenText().includes(needle),
      needle,
      options,
    );
  }

  async waitForAny(
    needles: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    await this.#waitFor(
      () => needles.some((needle) => this.screenText().includes(needle)),
      needles.join(" | "),
      options,
    );
  }

  /**
   * A token the harness prints itself, used to know a command finished. A
   * prompt is not a reliable signal: each shell repaints it differently, and
   * asking "is there a new prompt below" couples the harness to that.
   */
  #nextToken(): string {
    return `${PROMPT}_done_${String(++this.#tokens)}`;
  }

  async waitForPrompt(
    options: { timeoutMs?: number; afterRow?: number } = {},
  ): Promise<void> {
    // Positional, not textual: a prompt marker is compared after trimming, so
    // looking for "__pfx " would never match. `afterRow` requires a *new*
    // prompt, which is what separates "the command ran" from "the shell was
    // already sitting at a prompt".
    const from = options.afterRow ?? -1;
    await this.#waitFor(
      () => {
        const row = this.#promptRow();
        return row !== -1 && row > from;
      },
      `${PROMPT} below row ${String(from)}`,
      options,
    );
  }

  /** The row of the most recent prompt, or -1 when none is on screen. */
  #promptRow(): number {
    const buffer = this.#terminal.buffer.active;
    for (let row = buffer.baseY + buffer.cursorY; row >= 0; row--) {
      if (this.#rowText(row).trim() === PROMPT) {
        return row;
      }
    }
    return -1;
  }

  async #waitFor(
    condition: () => boolean,
    what: string,
    options: { timeoutMs?: number },
  ): Promise<void> {
    const deadline = Date.now() + (options.timeoutMs ?? this.#timeoutMs);
    while (Date.now() < deadline) {
      if (condition()) {
        return;
      }
      await sleep(20);
    }
    throw new Error(
      `timed out waiting for ${JSON.stringify(what)}.\n` +
        `--- screen ---\n${this.screenText()}\n--- raw tail ---\n${this.#output.slice(-400)}`,
    );
  }

  /**
   * Runs a command line and returns what it printed, with the echoed command
   * and the prompt removed. Rows are located by position rather than by
   * matching text, so trailing spaces in a prompt cannot break it.
   */
  async run(command: string): Promise<string> {
    const before = this.#cursorRow();
    const token = this.#nextToken();
    this.sendLine(`${command}; printf '${token}\\n'`);
    await this.waitFor(token);
    // Located rather than inferred from the cursor, because a shell may or may
    // not have painted a prompt under the token by the time it is read.
    return this.#rowsBetween(before, this.#rowOf(token));
  }

  /** The row of the last line whose whole content is `text`, else -1. */
  #rowOf(text: string): number {
    const buffer = this.#terminal.buffer.active;
    for (let row = buffer.baseY + buffer.cursorY; row >= 0; row--) {
      if (this.#rowText(row).trim() === text) {
        return row;
      }
    }
    return -1;
  }

  /**
   * Waits for a prompt after typing, using a token rather than the prompt, so
   * a shell that repaints its prompt mid-turn cannot stall the wait.
   */
  async waitForTypedLine(typed: string): Promise<string> {
    const token = this.#nextToken();
    this.send(`${typed}; printf '${token}\\n'`);
    await this.waitFor(token);
    return this.#rowsBetween(-1, this.#rowOf(token));
  }

  #cursorRow(): number {
    const buffer = this.#terminal.buffer.active;
    return buffer.baseY + buffer.cursorY;
  }

  #rowText(row: number): string {
    return (
      this.#terminal.buffer.active.getLine(row)?.translateToString(true) ?? ""
    );
  }

  #rowsBetween(from: number, to: number): string {
    const out: string[] = [];
    for (let row = from + 1; row < to; row++) {
      out.push(this.#rowText(row));
    }
    return out.join("\n").trim();
  }

  /**
   * Runs a command and returns its exit status. The status is printed by the
   * same command that runs it, so only one prompt has to be waited for.
   */
  async status(command: string): Promise<number> {
    const probe =
      this.#shell === "fish"
        ? "printf '__pfx_status=%s\\n' $status"
        : "printf '__pfx_status=%s\\n' \"$?\"";
    const out = await this.run(`${command}; ${probe}`);
    return Number(readMarker(out, "__pfx_status="));
  }

  /**
   * Reads a shell variable by printing it, so no shell API is needed. The
   * expansion syntax differs between fish and the others.
   */
  async readVariable(name: string): Promise<string> {
    const probe =
      this.#shell === "fish"
        ? `printf '__pfx_var=%s\\n' $${name}`
        : `eval 'printf "__pfx_var=%s\\n" "\${${name}}"'`;
    const out = await this.run(probe);
    return readMarker(out, "__pfx_var=");
  }

  /** The row of the newest prompt, for a test that must see a new one. */
  promptRow(): number {
    return this.#promptRow();
  }

  get cwd(): string {
    return this.#dir;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#child.kill();
    } catch {
      // Already gone, which is the state close is trying to reach.
    }
    this.#terminal.dispose();
    // The dying shell may still be writing its history file, so removal is
    // retried and then given up on. A leaked temp directory is a far smaller
    // problem than a red suite over teardown.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(this.#dir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
        return;
      } catch {
        await sleep(100);
      }
    }
  }
}

/**
 * Replies to the terminal queries a shell makes at startup. Anything not
 * answered here is a behaviour difference between this harness and a real
 * terminal, and shells notice.
 */
export function answerQueries(
  chunk: string,
  terminal: HeadlessTerminal,
): string[] {
  const replies: string[] = [];
  if (chunk.includes("\u001b[6n")) {
    const buffer = terminal.buffer.active;
    const row = buffer.baseY + buffer.cursorY + 1;
    replies.push(`\u001b[${String(row)};1R`);
  }
  if (chunk.includes("\u001b]11;?") || chunk.includes("\u001b]11;?\u0007")) {
    // Background colour: report a dark default.
    replies.push("\u001b]11;rgb:0000/0000/0000\u001b\\");
  }
  if (chunk.includes("\u001b[>0q")) {
    replies.push("\u001bP>|prefaix-headless(1.0)\u001b\\");
  }
  if (chunk.includes("\u001b[c")) {
    replies.push("\u001b[?62;c");
  }
  if (chunk.includes("\u001b[?u")) {
    // Kitty keyboard protocol query: decline the extended form.
    replies.push("\u001b[?0u");
  }
  return replies;
}

function promptFor(shell: ShellKind): string[] {
  switch (shell) {
    case "zsh":
      return [`PS1='${PROMPT} '`, "PROMPT2='> '"];
    case "bash":
      return [`PS1='${PROMPT} '`, `PS2='> '`];
    case "fish":
      return [`function fish_prompt; echo -n "${PROMPT} "; end`];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
