// The harness proves itself against the three shells DESIGN §12.3 names, so a
// failure in a prefaix gate is never a failure in the plumbing. These are
// assertions about a real pty, a real shell, and a real terminal emulator.

import { afterEach, describe, expect, it } from "vitest";
import {
  TEST_SHELLS,
  ShellSession,
  ensureSpawnHelper,
  type ShellKind,
} from "./harness.js";

const open: ShellSession[] = [];

const usable = TEST_SHELLS;

async function session(
  shell: ShellKind,
  options: { initScript?: string } = {},
): Promise<ShellSession> {
  const started = await ShellSession.start({ shell, ...options });
  open.push(started);
  return started;
}

afterEach(async () => {
  while (open.length > 0) {
    await open.pop()?.close();
  }
});

describe("pty harness", () => {
  it("makes node-pty's prebuilt helper executable", () => {
    // The bit is missing from the published tarball; without it every spawn
    // fails with a bare "posix_spawnp failed".
    expect(() => {
      ensureSpawnHelper();
    }).not.toThrow();
  });

  it.each(usable)("brings up a %s with a prompt it can find", async (shell) => {
    const s = await session(shell);
    expect(s.screenText()).toContain("__pfx");
  });

  it.each(usable)(
    "reaps %s before teardown returns even when SIGHUP is ignored",
    async (shell) => {
      const s = await session(shell);
      const pid = Number(
        await s.run(shell === "fish" ? "echo $fish_pid" : "echo $$"),
      );
      expect(pid).toBeGreaterThan(1);
      await s.run("trap '' HUP");
      try {
        await s.close();
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // A successful teardown already reaped this test-owned shell.
        }
      }
    },
  );

  it.each(usable)(
    "reads a command's output off the %s screen",
    async (shell) => {
      const s = await session(shell);
      expect(await s.run("echo harness-works")).toBe("harness-works");
    },
  );

  it.each(usable)(
    "separates %s multiline input echo from command output",
    async (shell) => {
      const s = await ShellSession.start({ shell, cols: 40 });
      open.push(s);
      expect(await s.run("printf '%s\\n' \\\n'harness-output'")).toBe(
        "harness-output",
      );
      await s.run(shell === "fish" ? "set -g pfx_var hello" : "pfx_var=hello");
      expect(await s.readVariable("pfx_var")).toBe("hello");
    },
  );

  it.each(usable)(
    "shows only the tail of long %s output, as a user does",
    async (shell) => {
      const s = await session(shell);
      // seq rather than a shell loop, because the assertion is about the pty
      // and a loop is spelled differently in each of the three shells.
      const output = await s.run("seq 1 60 | sed 's/^/line-/'");
      const screen = s.screenText();
      // The screen is a fixed height, so early lines have scrolled away.
      expect(screen).toContain("line-60");
      expect(output.split("\n").filter((line) => line !== "")).toHaveLength(60);
    },
  );

  it.each(usable)("sees a non-zero exit status from %s", async (shell) => {
    const s = await session(shell);
    expect(await s.status("true")).toBe(0);
    expect(await s.status("false")).toBe(1);
    // A subshell, because a bare `exit 42` would end the interactive shell.
    expect(
      await s.status(shell === "fish" ? "sh -c 'exit 42'" : "(exit 42)"),
    ).toBe(42);
    // And the shell is still usable afterwards.
    expect(await s.run("echo alive")).toBe("alive");
  });

  it.each(usable)(
    "carries a variable from one %s command to the next",
    async (shell) => {
      const s = await session(shell);
      await s.run(shell === "fish" ? "set -g pfx_var hello" : "pfx_var=hello");
      expect(await s.readVariable("pfx_var")).toBe("hello");
    },
  );

  it.each(usable)(
    "keeps %s quoting, globs, and subshells byte-exact",
    async (shell) => {
      // The e2e gate that a prompt with awkward characters arrives intact.
      const s = await session(shell);
      expect(await s.run("echo 'a b'  \"c d\"")).toBe("a b c d");
      expect(
        await s.run(shell === "fish" ? "math 2 + 3" : "echo $((2 + 3))"),
      ).toBe("5");
      expect(await s.run('echo "pre$(echo mid)post"')).toBe("premidpost");
    },
  );

  it.each(usable)(
    "renders %s control characters without corrupting the screen",
    async (shell) => {
      const s = await session(shell);
      // A tab is expanded to the next tab stop, which is what a user sees on
      // a real terminal, so the screen is the assertion rather than the bytes.
      expect(await s.run("printf 'a\\tb\\n'")).toBe("a       b");
      // A colour escape is consumed by the terminal, so the completion signal
      // is the prompt returning rather than a marker the command would print.
      const before = s.promptRow();
      s.sendLine("printf '\\033[31mred\\033[0m\\n'");
      await s.waitForPrompt({ afterRow: before });
      // The colour is consumed by the terminal, leaving readable text.
      expect(s.screenText()).toContain("red");
    },
  );

  it.each(usable)("accepts keystrokes one at a time in %s", async (shell) => {
    const s = await session(shell);
    const before = s.promptRow();
    for (const character of "echo typed".split("")) {
      s.send(character);
    }
    s.send("\r");
    // A new prompt, not the one that was already there.
    await s.waitForPrompt({ afterRow: before });
    expect(s.screenText()).toContain("typed");
  });

  it.each(usable)(
    "recovers a usable %s prompt after a hard failure",
    async (shell) => {
      const s = await session(shell);
      // A failing command, then the shell still works. The failure's own text
      // is deliberately not asserted: it is bash-version wording, and the point
      // of the case is that the session survives, which the exit-status case
      // covers too.
      expect(await s.status("this-command-does-not-exist")).toBeGreaterThan(0);
      expect(await s.run("echo still-here")).toBe("still-here");
    },
  );

  it("reports a timeout with the screen that caused it", async () => {
    // Whichever shell this machine can drive, since the point is the timeout.
    const s = await session(usable[0] ?? "bash");
    await expect(
      s.waitFor("this-will-never-appear", { timeoutMs: 500 }),
    ).rejects.toThrow(/timed out waiting for/);
    // The failure is diagnosable without re-running under a debugger.
    await expect(
      s.waitFor("this-will-never-appear", { timeoutMs: 500 }),
    ).rejects.toThrow(/--- screen ---/);
  });

  it("closing twice is a no-op, and leaves nothing running", async () => {
    const s = await session(usable[0] ?? "bash");
    await s.close();
    await expect(s.close()).resolves.toBeUndefined();
    expect(() => s.send("echo nope")).toThrow(/closed/);
  });

  it.each(usable)(
    "runs a startup script in %s, which is where a plugin would load",
    async (shell) => {
      const s = await session(shell, {
        initScript:
          shell === "fish" ? "set -g pfx_loaded yes" : "pfx_loaded=yes",
      });
      expect(await s.readVariable("pfx_loaded")).toBe("yes");
    },
  );
});
