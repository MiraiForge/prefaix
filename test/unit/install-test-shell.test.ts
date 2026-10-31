import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const prefixes: string[] = [];

afterEach(() => {
  for (const prefix of prefixes.splice(0)) {
    rmSync(prefix, { recursive: true, force: true });
  }
});

function installedShell(shell: string, version: string, featureExit: number) {
  const prefix = mkdtempSync(join(tmpdir(), "pfx-installed-shell-"));
  prefixes.push(prefix);
  mkdirSync(join(prefix, "bin"));
  writeFileSync(
    join(prefix, "bin", shell),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf '%s\\n' '${shell}, version ${version}'\nelse\n  exit ${String(featureExit)}\nfi\n`,
    { mode: 0o755 },
  );
  return prefix;
}

function install(shell: string, version: string, prefix: string) {
  return spawnSync(
    process.execPath,
    ["scripts/install-test-shell.mjs", shell, version, prefix],
    { encoding: "utf8", timeout: 5_000 },
  );
}

describe.skipIf(process.platform === "win32")("cached test shells", () => {
  it("rejects the requested Bash version when job control is missing", () => {
    const prefix = installedShell("bash", "4.4.0", 2);
    const result = install("bash", "4.4", prefix);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "lacks job control required by the PTY tests",
    );
  });

  it("accepts the requested Bash version when job control works", () => {
    const prefix = installedShell("bash", "4.4.0", 0);
    const result = install("bash", "4.4", prefix);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(join(prefix, "bin", "bash"));
  });

  it("still rejects a different installed version", () => {
    const prefix = installedShell("bash", "5.2.0", 0);
    const result = install("bash", "4.4", prefix);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not the requested bash 4.4");
  });

  it("does not apply Bash's feature probe to Fish", () => {
    const prefix = installedShell("fish", "3.6.4", 2);
    const result = install("fish", "3.6.4", prefix);
    expect(result.status).toBe(0);
  });
});
