import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/check-private.mjs", import.meta.url),
);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runGuard(manifest: object, ref = "", event = "") {
  const cwd = mkdtempSync(join(tmpdir(), "prefaix-private-"));
  directories.push(cwd);
  writeFileSync(join(cwd, "package.json"), JSON.stringify(manifest));
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF: ref, GITHUB_EVENT_NAME: event },
  });
}

describe("package privacy gate", () => {
  it.each([
    ["refs/heads/main", "push"],
    ["refs/pull/1/merge", "pull_request"],
    ["refs/tags/v0.1.0", "push"],
    ["", ""],
  ])("accepts a private package at %s (%s)", (ref, event) => {
    const result = runGuard({ private: true, version: "0.0.0" }, ref, event);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([false, undefined, "true", 1, null])(
    "rejects private=%s on main",
    (privateValue) => {
      const result = runGuard(
        { private: privateValue, version: "0.1.0" },
        "refs/heads/main",
        "push",
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must set private: true");
    },
  );

  it("permits a matching stable release tag push", () => {
    const result = runGuard(
      { private: false, version: "0.1.0" },
      "refs/tags/v0.1.0",
      "push",
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["refs/heads/v0.1.0", "push"],
    ["refs/tags/v0.1.0", "pull_request"],
    ["refs/tags/v0.1.0", "workflow_dispatch"],
    ["refs/tags/v0.2.0", "push"],
    ["refs/tags/v01.1.0", "push"],
    ["refs/tags/v0.1.0-rc.1", "push"],
    ["refs/tags/vanything", "push"],
    ["", ""],
  ])("rejects an unprivate package at %s (%s)", (ref, event) => {
    const result = runGuard({ private: false, version: "0.1.0" }, ref, event);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must set private: true");
  });
});
