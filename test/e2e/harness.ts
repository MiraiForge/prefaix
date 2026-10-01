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
  onData(callback: (data: string) => void): void;
  resize(cols: number, rows: number): void;
  readonly rows: number;
  buffer: {
    active: {
      baseY: number;
      cursorY: number;
      length: number;
      getLine(y: number):
        | {
            readonly isWrapped: boolean;
            translateToString(trimRight?: boolean): string;
          }
        | undefined;
    };
  };
  dispose(): void;
}

export type ShellKind = "zsh" | "fish" | "bash";

export const SHELL_KINDS: readonly ShellKind[] = ["zsh", "fish", "bash"];
export const TEST_SHELLS: readonly ShellKind[] = process.env[
  "PREFAIX_E2E_SHELLS"
]
  ? process.env["PREFAIX_E2E_SHELLS"].split(",").map((shell) => {
      if (!SHELL_KINDS.includes(shell as ShellKind))
        throw new Error(`Invalid test shell: ${shell}`);
      return shell as ShellKind;
    })
  : SHELL_KINDS;

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
  bash: [
    "/opt/homebrew/bin/bash",
    "/usr/local/bin/bash",
    "/bin/bash",
    "/usr/bin/bash",
  ],
  fish: ["/usr/bin/fish", "/opt/homebrew/bin/fish", "/usr/local/bin/fish"],
};

/** Pulls a marker value out of command output, or an empty string. */
function readMarker(output: string, marker: string): string {
  for (const line of output.split("\n")) {
    if (line.startsWith(marker)) {
      return line.slice(marker.length).trim();
    }
  }
  return "";
}

export function resolveShellBin(shell: ShellKind): string {
  const override = process.env[`PREFAIX_E2E_${shell.toUpperCase()}`];
  if (override) return override;
  if (shell === "bash") {
    for (const candidate of ["/opt/homebrew/bin/bash", "/usr/local/bin/bash"]) {
      if (existsSync(candidate)) return candidate;
    }
  }
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
    args: (rcFile) => [
      "--no-config",
      "--interactive",
      "--init-command",
      `source '${rcFile}'`,
    ],
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
 * A diagnostic probe for optional integrations. Required CI suites fail when
 * a shell cannot start; the shared harness and plugin suites always require
 * every shell selected by TEST_SHELLS.
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
    await session.close();
    return { shell, available: true };
  } catch (error) {
    if (process.env["PREFAIX_E2E_REQUIRED"] === "1") throw error;
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
  readonly #exited: Promise<void>;
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
    this.#exited = new Promise<void>((resolve) => {
      child.onExit(() => resolve());
    });
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
      HOME: options.env?.["HOME"] ?? dir,
      XDG_CONFIG_HOME: options.env?.["XDG_CONFIG_HOME"] ?? join(dir, "config"),
      XDG_DATA_HOME: options.env?.["XDG_DATA_HOME"] ?? join(dir, "data"),
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
    terminal.onData((data) => child.write(data));
    child.onData((data: string) => {
      session.#output += data;
      terminal.write(data);
      // A real terminal answers the shell's capability queries, and a shell
      // that gets no answer can give up: fish exits on an unanswered cursor
      // position request. Answering is part of emulating a terminal, not a
      // special case for one shell.
      for (const reply of answerQueries(data)) {
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
      await session.close();
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
    for (let y = 0; y < this.#terminal.rows; y++) {
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

  press(key: "enter" | "escape" | "ctrl-c" | "up" | "down" | "tab"): void {
    this.send(
      {
        enter: "\r",
        escape: "\x1b",
        "ctrl-c": "\x03",
        up: "\x1b[A",
        down: "\x1b[B",
        tab: "\t",
      }[key],
    );
  }

  paste(text: string): void {
    this.send(`\x1b[200~${text}\x1b[201~`);
  }

  resize(cols: number, rows: number): void {
    this.#terminal.resize(cols, rows);
    this.#child.resize(cols, rows);
  }

  sendLine(text: string): void {
    this.send(`${text}\r`);
  }

  async waitFor(
    needle: string | RegExp,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    await this.#waitFor(
      () =>
        typeof needle === "string"
          ? this.screenText().includes(needle)
          : needle.test(this.screenText()),
      String(needle),
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
    const row = buffer.baseY + buffer.cursorY;
    if (this.#rowText(row).trim() === PROMPT) return row;
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
  /**
   * Waits for a row that is exactly the token.
   *
   * Not a substring match on the screen: the shell echoes the command we typed,
   * and the token is in that echoed text, so a substring wait is satisfied by
   * the echo before the command has run at all. The real token is printed by
   * printf with a trailing newline, so it always lands alone on its own row.
   */
  async #waitForTokenRow(
    token: string,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    await this.#waitFor(
      () => this.#rowOf(token) !== -1,
      `${token} on a row of its own`,
      options,
    );
  }

  async run(command: string): Promise<string> {
    if (/^\s*:/u.test(command))
      throw new Error(
        "Drive colon interception with sendLine and waitForPrompt.",
      );
    await this.waitForPrompt();
    const token = this.#nextToken();
    const startToken = `${token}_start`;
    this.sendLine(
      `printf '${startToken}\\n'; ${command}; printf '${token}\\n'`,
    );
    await this.#waitForTokenRow(token);
    const start = this.#rowOf(startToken);
    const end = this.#rowOf(token);
    if (start === -1 || end <= start) {
      // The token was seen in the stream but is not on the screen, so the rows
      // for it are unknowable. Saying so beats returning an empty answer.
      throw new Error(
        `the output markers for ${JSON.stringify(command)} are not on the ` +
          `screen.\n--- screen ---\n${this.screenText()}`,
      );
    }
    // The token's own row is included, with the token removed, because a
    // command's stderr and its stdout can land on one line and the row before
    // it is then not the whole answer.
    const rows: string[] = [];
    for (let row = start + 1; row <= end; row++) {
      rows.push(this.#rowText(row));
    }
    const last = rows.length - 1;
    rows[last] = (rows[last] ?? "").replace(token, "");
    await this.waitForPrompt({ afterRow: end });
    return rows.join("\n").replace(/\n+$/, "").trim();
  }

  /**
   * The row of the last line containing `text`, else -1. A match rather than an
   * equality, because a command that prints nothing puts the token on the same
   * row as the prompt.
   */
  /** The row whose whole content is `text`, searching up from the cursor. */
  #rowOf(text: string): number {
    const buffer = this.#terminal.buffer.active;
    for (let row = buffer.baseY + buffer.cursorY; row >= 0; row--) {
      if (this.#rowText(row).trim() === text) {
        return row;
      }
    }
    return -1;
  }

  #rowText(row: number): string {
    return (
      this.#terminal.buffer.active.getLine(row)?.translateToString(true) ?? ""
    );
  }

  /**
   * Runs a command and returns its exit status. The status is printed by the
   * same command that runs it, so only one prompt has to be waited for.
   */
  async status(command: string): Promise<number> {
    const probe =
      this.#shell === "fish"
        ? "printf '__pfx_%s=%s\\n' status $status"
        : "printf '__pfx_%s=%s\\n' status \"$?\"";
    const out = await this.run(`${command}; ${probe}`);
    return Number(readMarker(out, "__pfx_status="));
  }

  /**
   * Reads a shell variable by printing it, so no shell API is needed. The
   * expansion syntax differs between fish and the others.
   */
  async readVariable(name: string): Promise<string> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
      throw new Error("Invalid variable name");
    const probe = `printf '__pfx_%s=%s\\n' var "$${name}"`;
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
    if (!(await this.#waitForExit(1_000))) {
      try {
        this.#child.kill("SIGKILL");
      } catch {
        // Exit may have won the race with the escalation deadline.
      }
      if (!(await this.#waitForExit(3_000))) {
        throw new Error(`${this.#shell} did not exit during PTY teardown`);
      }
    }
    this.#terminal.dispose();
    // Reap the shell before removing its HOME or opening another session.
    // Descendants may still finish writing history, so removal is retried.
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

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Replies to the terminal queries a shell makes at startup. Anything not
 * answered here is a behaviour difference between this harness and a real
 * terminal, and shells notice.
 */
export function answerQueries(chunk: string): string[] {
  const replies: string[] = [];
  if (chunk.includes("\u001b]11;?") || chunk.includes("\u001b]11;?\u0007")) {
    // Background colour: report a dark default.
    replies.push("\u001b]11;rgb:0000/0000/0000\u001b\\");
  }
  if (chunk.includes("\u001b[>0q")) {
    replies.push("\u001bP>|prefaix-headless(1.0)\u001b\\");
  }
  // No Kitty reply: CSI ? 0 u advertises support with no active flags. This
  // harness sends legacy key bytes, so fish must detect an unsupported terminal.
  return replies;
}

function promptFor(shell: ShellKind): string[] {
  switch (shell) {
    case "zsh":
      return [`PS1='${PROMPT} '`, "PROMPT2='> '"];
    case "bash":
      return [`PS1='${PROMPT} '`, `PS2='> '`];
    case "fish":
      return [
        `function fish_prompt; echo -n "${PROMPT} "; end`,
        "function fish_mode_prompt; end",
        "set -gx PAGER cat",
        "set -e fish_private_mode",
        "set -g fish_history prefaix_test",
      ];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
