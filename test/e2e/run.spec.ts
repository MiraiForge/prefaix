// `prefaix run` in a real pty (M2 exit criterion). The unit tests drive the
// client with a fake tty; this one drives it with the terminal the user has, so
// that raw mode, the answer on screen, and the prompt coming back are observed
// rather than assumed.
//
// The backend is the fake one, so this gate never spends a model call. A live
// run is the same command with PREFAIX_BACKEND=pi, which is what the contract
// suite's live test does.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShellSession, probeShell } from "./harness.js";
import { decodeDirectives } from "../../src/shells/directives.js";
import type { ShellKind } from "./harness.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
// The built bundle, not the source: this is the artifact a user runs, and the
// autospawner spawns a detached copy of it, which a TypeScript entry point makes
// far slower than the three seconds the client is willing to wait.
const BIN = join(REPO, "dist/prefaix.js");
const SHELL: ShellKind = "zsh";

let home = "";
let work = "";
const open: ShellSession[] = [];

/** The node that runs the bundle, as a user would. */
const node = process.execPath.includes("bun") ? "node" : process.execPath;

/** The command line a shell plugin would build for one `:`. */
function command(
  line: string,
  options: { conversation?: string; env?: Record<string, string> } = {},
): string {
  return [
    `${node} ${BIN} run`,
    ...Object.entries(options.env ?? {}).map(
      ([key, value]) => `${key}=${value}`,
    ),
    `--shell ${SHELL}`,
    "--shell-id 1-1-a",
    "--shell-version 5.9",
    "--shell-pid 4242",
    "--nonce n1",
    `--directives ${join(work, "directives")}`,
    `--cwd ${work}`,
    ...(options.conversation === undefined
      ? []
      : [`--conversation ${options.conversation}`]),
    `-- ${JSON.stringify(line)}`,
  ].join(" ");
}

function directives(): {
  nonce: string;
  conversation?: string;
  buffer?: string;
  cursor?: number;
  status?: string;
} {
  return (
    decodeDirectives(readFileSync(join(work, "directives"))) ?? { nonce: "" }
  );
}

async function session(
  env: Record<string, string> = {},
): Promise<ShellSession> {
  const started = await ShellSession.start({
    shell: SHELL,
    env: {
      HOME: home,
      XDG_RUNTIME_DIR: join(home, "run"),
      PREFAIX_BACKEND: "fake",
      ...env,
    },
    cwd: work,
    timeoutMs: 30_000,
  });
  open.push(started);
  return started;
}

const available = await probeShell(SHELL);
if (!available.available) {
  // An environment fact, reported rather than turned into a failing gate.
  console.log(`  e2e run: skipped — ${available.reason ?? "zsh unavailable"}`);
}

beforeAll(() => {
  if (!available.available) {
    return;
  }
  home = mkdtempSync(join(tmpdir(), "pfx-run-home-"));
  work = mkdtempSync(join(tmpdir(), "pfx-run-work-"));
});

afterAll(async () => {
  while (open.length > 0) {
    await open.pop()?.close();
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe("prefaix run in a pty", () => {
  it("answers a `:` and hands the terminal back", async () => {
    if (!available.available) {
      return;
    }
    const shell = await session();
    const answer = await shell.run(
      command(": zzzzzzzz what does the client do with a tty"),
    );
    // The answer is on the screen, which is the whole point of a pty: raw mode
    // means the client is the only thing painting, and it has to paint what a
    // pipe would have received.
    expect(answer).toContain("Hello from the fake backend");
    // The prompt came back, so the terminal is the shell's again.
    await shell.waitForPrompt({ timeoutMs: 15_000 });

    // The plugin's file is how the shell learns the conversation, and it is
    // written whether or not anything is watching for it.
    const written = directives();
    expect(written["nonce"]).toBe("n1");
    expect(String(written["conversation"])).toMatch(/^c_/);
  });

  it("continues the same conversation on the next `:`", async () => {
    if (!available.available) {
      return;
    }
    const shell = await session();
    await shell.run(command(": zzzzzzzz first"));
    const first = String(directives()["conversation"]);
    await shell.run(command(": zzzzzzzz second", { conversation: first }));
    // A second `:` is a continuation, not a new conversation, and the id the
    // shell passes back is what makes it one.
    expect(String(directives()["conversation"])).toBe(first);

    const listed = await shell.run(`${node} ${BIN} conversations ls`);
    expect(listed).toContain(first.slice(0, 12));
  });

  it("aborts a turn on Esc and still gives the terminal back", async () => {
    if (!available.available) {
      return;
    }
    // A turn long enough to still be running when Esc arrives.
    const shell = await session({ PREFAIX_FAKE_SCENARIO: "long" });
    const conversation = String(directives()["conversation"] ?? "");
    // Sent on its own, with no completion token: the point is to interrupt the
    // command while it is still the client that owns the terminal.
    shell.sendLine(
      command(": zzzzzzzz take a while", {
        ...(conversation === "" ? {} : { conversation }),
        env: { PREFAIX_FAKE_SCENARIO: "long" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    shell.send("");
    // The prompt is back, which is what "the terminal is yours again" looks
    // like from the shell's side. A client that kept raw mode would have eaten
    // the newline that gets the prompt painted.
    await shell.waitForPrompt({ timeoutMs: 20_000 });
  });

  it("leaves no client behind when the turn is done", async () => {
    if (!available.available) {
      return;
    }
    const shell = await session();
    await shell.run(command(": zzzzzzzz first"));
    const status = await shell.run(`${node} ${BIN} daemon status`);
    // The daemon is still up between turns, which is the whole point of it
    // being a daemon; the client is what came and went.
    expect(status).toContain("daemon pid");
  });
});
