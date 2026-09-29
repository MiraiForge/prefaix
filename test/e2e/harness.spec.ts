// The harness proves itself against the three shells DESIGN §12.3 names, so a
// failure in a prefaix gate is never a failure in the plumbing. These are
// assertions about a real pty, a real shell, and a real terminal emulator.

import { afterEach, describe, expect, it } from "vitest";
import {
  SHELL_KINDS,
  ShellSession,
  ensureSpawnHelper,
  probeShell,
  type ShellKind,
  type ShellAvailability,
} from "./harness.js";

const open: ShellSession[] = [];

// Probed once: a shell that cannot be driven here is skipped everywhere with
// the reason, rather than failing every gate for an environment fact.
const availability: ShellAvailability[] = await Promise.all(
  SHELL_KINDS.map((shell) => probeShell(shell)),
);
const usable = SHELL_KINDS.filter(
  (shell) =>
    availability.find((entry) => entry.shell === shell)?.available === true,
);
const unusable = availability.filter((entry) => !entry.available);

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
  it("reports which shells this machine can drive", () => {
    // Printed rather than asserted, so a run that skips fish says why.
    for (const entry of availability) {
      console.log(
        `  e2e shell ${entry.shell}: ${entry.available ? "available" : `unavailable — ${entry.reason ?? "unknown"}`}`,
      );
    }
    expect(usable.length).toBeGreaterThan(0);
  });

  it("notes when prefaix's default shell cannot be driven here", () => {
    // Not an assertion: CI installs the shells DESIGN 12.5 lists, and a runner
    // that could not install them should say so rather than fail here.
    if (!usable.includes("zsh")) {
      console.log(
        "  note: zsh is unavailable, so no zsh gate ran. DESIGN 12.5 has CI " +
          "install it.",
      );
    }
    expect(usable.length).toBeGreaterThan(0);
  });

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
    "reads a command's output off the %s screen",
    async (shell) => {
      const s = await session(shell);
      expect(await s.run("echo harness-works")).toBe("harness-works");
    },
  );

  it.each(usable)(
    "shows only the tail of long %s output, as a user does",
    async (shell) => {
      const s = await session(shell);
      const output = await s.run(
        "i=1; while [ $i -le 60 ]; do echo line-$i; i=$((i+1)); done",
      );
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
    expect(await s.status("(exit 42)")).toBe(42);
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
      expect(await s.run("echo $((2 + 3))")).toBe("5");
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
      await s.run("this-command-does-not-exist-2>/dev/null || true");
      expect(await s.run("echo still-here")).toBe("still-here");
    },
  );

  it("skips nothing silently", () => {
    // Every shell is either driven or has a recorded reason.
    for (const entry of unusable) {
      expect(
        entry.reason,
        `${entry.shell} must say why it is skipped`,
      ).toBeTruthy();
    }
  });

  it("reports a timeout with the screen that caused it", async () => {
    const s = await session("zsh");
    await expect(
      s.waitFor("this-will-never-appear", { timeoutMs: 500 }),
    ).rejects.toThrow(/timed out waiting for/);
    // The failure is diagnosable without re-running under a debugger.
    await expect(
      s.waitFor("this-will-never-appear", { timeoutMs: 500 }),
    ).rejects.toThrow(/--- screen ---/);
  });

  it("closing twice is a no-op, and leaves nothing running", async () => {
    const s = await session("bash");
    await s.close();
    await expect(s.close()).resolves.toBeUndefined();
    expect(() => s.send("echo nope")).toThrow(/closed/);
  });

  it("runs a startup script, which is where a plugin would load", async () => {
    const s = await session("zsh", { initScript: "pfx_loaded=yes" });
    expect(await s.readVariable("pfx_loaded")).toBe("yes");
  });
});
