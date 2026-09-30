// iTerm2 as a rendering target (M2-10's visual check, second half).
//
// The pty harness in harness.spec.ts proves the client drives a terminal; it
// cannot prove how any *particular* terminal draws the result, and terminals
// disagree about exactly the things a renderer depends on — iTerm2 has its own
// scroll-region and carriage-return handling, so a footer that rewrites
// cleanly in Ghostty can still double-print or leave a stale row here. An eye
// is the only other way to check that, and an eye is not a gate: it does not
// run again next month. So this drives the real application.
//
// What it can and cannot see: iTerm2's AppleScript hands back the *text* of the
// session, not the attributes of each cell. So this catches text-level damage —
// a line printed twice, a footer left behind, a row overwritten, the terminal
// not handed back — and it cannot judge colour. Colour is a matter of the
// escape sequences, which the styler unit tests assert byte for byte, and which
// the person running this by eye is the right judge of.
//
// Skips itself when iTerm2 is not installed, which is the case on CI and on
// any machine that has not installed it. That is a fact about the machine, not
// a failure of the renderer.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * osascript on a script from stdin, synchronously. The blocks here are waits
 * for an application to paint, and there is nothing to overlap them with, so
 * the simpler API is the honest one.
 */
function osa(script: string): string {
  return execFileSync("osascript", ["-"], { input: script, encoding: "utf8" });
}

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const BIN = join(REPO, "dist/prefaix.js");
const ITERM = "/Applications/iTerm.app";

/**
 * iTerm2 is a GUI application, and a window it opens takes keyboard focus from
 * whatever the person at the machine is doing. So this suite is opt-in twice
 * over: it needs iTerm2 installed, and it needs to be asked for by name. It
 * does not run as part of `bun run test:e2e`, because a test suite that steals
 * focus is a test suite that gets skipped.
 */
const installed = existsSync(join(ITERM, "Contents/MacOS/iTerm2"));
const asked = process.env["PREFAIX_ITERM"] === "1";
const gates = installed && asked ? describe : describe.skip;
if (!installed) {
  console.log("  e2e iterm: skipped — iTerm2 is not installed");
} else if (!asked) {
  console.log(
    "  e2e iterm: skipped — set PREFAIX_ITERM=1 to drive iTerm2 (it opens a " +
      "window and would otherwise take focus)",
  );
}

/** Point width and height; iTerm2 derives columns and rows from them. */
const NARROW = { width: 470, height: 620 };
const WIDE = { width: 820, height: 620 };
/** The markdown scenario is longer than a default window, and `contents` is
 * the session's visible text, so a short window would scroll the first half of
 * the answer out of what the check can see. */
const TALL = { width: 900, height: 1600 };

let home = "";
let work = "";

/**
 * Runs a shell script in a fresh iTerm2 window and returns what the session
 * shows. The script goes in a file because the command under test is full of
 * quotes, and a quoting bug in an AppleScript string literal would look
 * exactly like a renderer bug.
 */
/**
 * The application that had focus, so it can have it back. Creating a window
 * focuses that window, and the person driving this suite is more likely to be
 * doing something else than watching a terminal open.
 */
function frontmostApp(): string {
  try {
    return osa(
      'tell application "System Events" to return bundle identifier of ' +
        "(first application process whose frontmost is true)",
    ).trim();
  } catch {
    return "";
  }
}

/** Hands the keyboard back to whatever had it before the window opened. */
function restoreFocus(to: string): void {
  if (to === "") {
    return;
  }
  try {
    osa(`tell application id "${to}" to activate`);
  } catch {
    // The app that had focus is gone; there is nothing to give it back to.
  }
}

function openWindow(size: { width: number; height: number }): string {
  const before = frontmostApp();
  osa('tell application "iTerm" to launch');
  const id = osa(`
tell application "iTerm"
  set w to (create window with default profile)
  set bounds of w to {0, 0, ${String(size.width)}, ${String(size.height)}}
  return id of w
end tell
`).trim();
  restoreFocus(before);
  return id;
}

async function inIterm(
  script: string,
  size: { width: number; height: number } = WIDE,
  keys?: { after: string; send: (window: string) => void },
): Promise<string> {
  const file = join(work, `iterm-${String(Math.random()).slice(2)}.sh`);
  writeFileSync(file, script, "utf8");
  chmodSync(file, 0o700);
  const window = openWindow(size);
  osa(`
tell application "iTerm"
  tell current session of window id ${window}
    write text "sh ${file}"
  end tell
end tell
`);
  if (keys !== undefined) {
    await waitForMarker(window, keys.after);
    keys.send(window);
  }
  try {
    return await readUntilDone(window);
  } finally {
    closeWindow(window);
  }
}

function closeWindow(window: string): void {
  try {
    osa(`tell application "iTerm" to close window id ${window}`);
  } catch {
    // A window the person closed by hand is not a failure of the check.
  }
}

/** Polls until the script has printed `marker`, which says a stage was reached. */
async function waitForMarker(window: string, marker: string): Promise<void> {
  let contents = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    contents = currentContents(window);
    if (contents.includes(marker)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `iTerm2 never reached ${marker}.\n--- screen ---\n${contents}`,
  );
}

/** Polls the window until the script has printed its end marker. */
async function readUntilDone(window: string): Promise<string> {
  let contents = "";
  for (let attempt = 0; attempt < 160; attempt += 1) {
    contents = currentContents(window);
    const start = contents.indexOf("__PFX_BEGIN__");
    const end = contents.indexOf("__PFX_END__", Math.max(start, 0));
    if (
      start !== -1 &&
      end !== -1 &&
      contents.indexOf("__ALIVE__", end) !== -1
    ) {
      return contents;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `iTerm2 never finished the script.\n--- screen ---\n${contents}`,
  );
}

function currentContents(window: string): string {
  return osa(`
tell application "iTerm"
  return contents of current session of window id ${window}
end tell
`);
}

function closeWindows(): void {
  try {
    osa(
      'tell application "iTerm" to repeat with w in windows' +
        " -e 'close w'" +
        " -e 'end repeat'",
    );
  } catch {
    // A window the person closed by hand is not a failure of the check.
  }
}

/**
 * The paths a check runs against, written into the script rather than inherited.
 * A window inherits the environment of the application that opened it, and
 * iTerm2 was already running long before this suite started — so relying on
 * `$XDG_RUNTIME_DIR` would have pointed the check at the person's real
 * conversations directory instead of a scratch one.
 */
function env(): string {
  return `XDG_RUNTIME_DIR=${join(home, "run")} XDG_STATE_HOME=${join(home, "state")}`;
}

function directives(): string {
  return join(home, "manual.d");
}

/**
 * The body of a check: a marker, one turn, a marker, and a line only a shell
 * with a working terminal can produce. That last line is the tty check — if
 * raw mode was left on, the shell would not echo `__ALIVE__`.
 */
function turnScript(scenario: string, prompt = ": zzzzzzzz go"): string {
  return [
    // The scenario is read when a child is spawned, and children inherit the
    // daemon's environment, so a daemon left over from the previous check would
    // replay that scenario instead of this one. Stopping it first is what makes
    // each of these an independent check rather than a rerun of the last.
    `${env()} node ${BIN} daemon stop >/dev/null 2>&1`,
    "echo __PFX_BEGIN__",
    `${env()} \\`,
    `  PREFAIX_BACKEND=fake PREFAIX_FAKE_SCENARIO=${scenario} \\`,
    `  node ${BIN} run --shell zsh --shell-id 1-1-a --shell-version 5.9 \\`,
    `  --shell-pid $$ --nonce n1 --directives ${directives()} \\`,

    `  --cwd "$PWD" -- '${prompt}'`,
    "echo __PFX_END__",
    "echo __ALIVE__",
  ].join("\n");
}

/** What the session shows between the markers, which is prefaix's own output. */
function between(contents: string): string {
  const start = contents.indexOf("__PFX_BEGIN__");
  if (start === -1) {
    throw new Error(
      `no marker in the iTerm2 session.\n--- screen ---\n${contents}`,
    );
  }
  const end = contents.indexOf("__PFX_END__", start);
  if (end === -1) {
    throw new Error(`the run never finished.\n--- screen ---\n${contents}`);
  }
  return contents.slice(start + "__PFX_BEGIN__".length, end);
}

/**
 * What was expected and was not there, rather than the first thing that failed.
 * A long body makes "expected X to contain Y" truncate the part that says what
 * actually went wrong.
 */
function missing(body: string, expected: readonly string[]): string[] {
  return expected.filter((wanted) => !body.includes(wanted));
}

/** Lines the renderer printed, with the screen's own blank rows dropped. */
function linesOf(contents: string): string[] {
  return between(contents)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeAll(() => {
  if (!installed) {
    return;
  }
  home = mkdtempSync(join(tmpdir(), "pfx-iterm-home-"));
  work = mkdtempSync(join(tmpdir(), "pfx-iterm-work-"));
  process.env["XDG_RUNTIME_DIR"] = join(home, "run");
  process.env["XDG_STATE_HOME"] = join(home, "state");
  if (!existsSync(join(REPO, "dist/prefaix.js"))) {
    throw new Error("dist/prefaix.js is missing; run `bun run build` first");
  }
});

afterAll(async () => {
  if (installed) {
    closeWindows();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

gates("iTerm2 as a rendering target", () => {
  it("draws every markdown shape once, and hands the terminal back", async () => {
    const contents = await inIterm(turnScript("markdown"), TALL);
    const body = between(contents);
    const lines = linesOf(contents);

    expect(
      missing(body, [
        "Heading one",
        "Heading two",
        "Body text with",
        "bold",
        "italic",
        "inline code",
        "first item",
        "nested item",
        "one",
        "a quote",
        "const answer: number = 42;",
        "| option | what it does |",
        "That is every shape.",
      ]),
      body,
    ).toEqual([]);
    // A row printed twice is the failure mode a terminal swap causes and a
    // text comparison is the only thing that can see it.
    const counts = new Map<string, number>();
    for (const line of lines) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    const doubled = [...counts].filter(([, n]) => n > 1).map(([line]) => line);
    expect(doubled).toEqual([]);

    // The footer is rewritten in place, so it must be on screen once.
    expect(countOccurrences(body, "── ")).toBe(1);
    // And the shell got its terminal back: it echoed the marker.
    expect(contents).toContain("__ALIVE__");
  }, 90_000);

  it("collapses tool lines and counts them in the footer", async () => {
    const contents = await inIterm(turnScript("tools"));
    const body = between(contents);
    expect(body).toContain("read");
    expect(body).toContain("src/core/config.ts");
    // Three tools ran, and the footer says so once.
    expect(countOccurrences(body, "3 tools")).toBe(1);
    // A tool that failed stays on screen: collapsing it away would be a lie.
    expect(body).toContain("grep");
  }, 90_000);

  it("shows an error notice without leaving half an answer", async () => {
    const contents = await inIterm(turnScript("error"));
    const body = between(contents);
    expect(body).toContain("Starting, then failing on purpose.");
    expect(body).toContain("scripted failure");
  }, 90_000);

  it("says a retry is happening and then answers", async () => {
    const contents = await inIterm(turnScript("retry"));
    const body = between(contents);
    expect(body).toContain("retrying");
    expect(body).toContain("Recovered on the third attempt.");
  }, 90_000);

  it("hands a buffer back to the shell", async () => {
    await inIterm(turnScript("buffer"));
    const written = readFileSync(directives(), "utf8");
    // NUL-delimited pairs, so the buffer is the fifth field.
    const fields = written.split("\0");
    expect(fields).toContain("buffer");
    expect(fields[fields.indexOf("buffer") + 1]).toBe(
      "git push --force-with-lease origin main",
    );
  }, 90_000);

  it("keeps a table readable in a narrow window", async () => {
    const contents = await inIterm(turnScript("markdown"), NARROW);
    const body = between(contents);
    // The fence and the prose survive a narrow terminal; what matters is that
    // the table's own rows were not interleaved with the shell's.
    expect(body).toContain("const answer: number = 42;");
    expect(body).toContain("| option | what it does |");
    expect(contents).toContain("__ALIVE__");
  }, 90_000);

  it("aborts a turn on a real Esc and still gives the terminal back", async () => {
    // The client is started in the background so the script can report that the
    // turn is under way, and the Esc is then sent by iTerm2 itself as a key
    // press. Writing an escape byte to stdout would have been the wrong thing
    // entirely: that is output, and a key press is input.
    const script = [
      `${env()} node ${BIN} daemon stop >/dev/null 2>&1`,
      "echo __PFX_BEGIN__",
      `${env()} PREFAIX_BACKEND=fake PREFAIX_FAKE_SCENARIO=long node ${BIN} run \\`,
      "  --shell zsh --shell-id 1-1-a --shell-version 5.9 --shell-pid $$ \\",
      `  --nonce n1 --directives ${directives()} --cwd $PWD \\`,
      "  -- ': zzzzzzzz go slow'",
      'echo "CLIENT-EXIT=$?"',
      "echo __PFX_END__",
      "echo __ALIVE__",
    ].join("\n");
    // Foreground, on purpose. Backgrounded, the shell stays the foreground
    // process of the pty and a key press goes to the shell rather than to the
    // client, which is not the thing being tested.
    const contents = await inIterm(script, TALL, {
      after: "line 1 of 120",
      send: (window) => {
        osa(`
tell application "iTerm"
  tell current session of window id ${window}
    write text (ASCII character 27)
  end tell
end tell
`);
      },
    });
    // The abort is the point, and the exit status is the honest witness: 130 is
    // the client's aborted code, and 0 would mean the turn ran to the end and
    // the Esc did nothing.
    expect(between(contents)).toContain("CLIENT-EXIT=130");
    // And the answer really is truncated rather than quietly complete.
    expect(between(contents)).not.toContain("line 120 of 120");
    // And the terminal came back, or the prompt would not have echoed.
    expect(contents).toContain("__ALIVE__");
  }, 90_000);
});
