import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const script = resolve("scripts/check-release.mjs");
it.each([
  {
    private: true,
    version: "0.1.0",
    ref: "refs/tags/v0.1.0",
    approved: "0.1.0",
    event: "push",
    ok: false,
  },
  {
    private: false,
    version: "0.0.0",
    ref: "refs/tags/v0.0.0",
    approved: "0.0.0",
    event: "push",
    ok: false,
  },
  {
    private: false,
    version: "0.1.0",
    ref: "refs/heads/main",
    approved: "0.1.0",
    event: "push",
    ok: false,
  },
  {
    private: false,
    version: "0.1.0",
    ref: "refs/tags/v0.1.0",
    approved: "",
    event: "push",
    ok: false,
  },
  {
    private: false,
    version: "0.1.1",
    ref: "refs/tags/v0.1.1",
    approved: "0.1.0",
    event: "push",
    ok: false,
  },
  {
    private: false,
    version: "0.1.0",
    ref: "refs/tags/v0.1.0",
    approved: "0.1.0",
    event: "pull_request",
    ok: false,
  },
  {
    private: false,
    version: "0.1.0",
    ref: "refs/tags/v0.1.0",
    approved: "0.1.0",
    event: "push",
    ok: true,
  },
])("requires exact version approval and a matching release tag: %j", (test) => {
  const home = mkdtempSync(join(tmpdir(), "pfx-release-"));
  try {
    writeFileSync(
      join(home, "package.json"),
      JSON.stringify({
        name: "@miraiforge/prefaix",
        private: test.private,
        version: test.version,
      }),
    );
    const result = spawnSync(process.execPath, [script], {
      cwd: home,
      env: {
        GITHUB_REF: test.ref,
        GITHUB_EVENT_NAME: test.event,
        APPROVED_RELEASE_VERSION: test.approved,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(test.ok ? 0 : 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
