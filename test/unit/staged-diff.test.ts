import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { stagedDiff, runCommit } from "../../src/context/staged-diff.js";

let dir: string;
let env: Record<string, string>;
function git(...args: string[]) {
  return execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
}
function stage(text = "日本語🙂\n") {
  writeFileSync(join(dir, "file.txt"), text);
  git("add", "file.txt");
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pfx-index-"));
  env = {
    HOME: dir,
    PATH: process.env.PATH!,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  git("init", "--quiet");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("reports empty stages, non-repositories, and missing git clearly", async () => {
  await expect(stagedDiff(dir, env, 100)).rejects.toThrow(/no staged changes/);
  const outside = join(dir, "outside");
  mkdirSync(outside);
  // Disable discovery above the test directory without changing the real repo.
  await expect(
    stagedDiff(outside, { ...env, GIT_DIR: join(dir, "missing") }, 100),
  ).rejects.toThrow(/cannot read staged diff/);
  await expect(
    stagedDiff(dir, { ...env, PATH: join(dir, "missing") }, 100),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("captures only staged changes, suppresses external diff, and hashes all bytes", async () => {
  stage();
  writeFileSync(join(dir, "file.txt"), "unstaged-secret\n");
  git("config", "diff.external", "false");
  const full = await stagedDiff(dir, env, 10000);
  expect(full.text).toContain("+日本語🙂");
  expect(full.text).not.toContain("unstaged-secret");
  expect(full.truncated).toBe(false);
  expect(full.hash).toBe(createHash("sha256").update(full.text).digest("hex"));
  const capped = await stagedDiff(dir, env, 20);
  expect(capped.text).toBe(full.text.slice(0, 20));
  expect(capped.truncated).toBe(true);
  expect(capped.hash).toBe(full.hash);
  const zero = await stagedDiff(dir, env, 0);
  expect(zero).toEqual({ text: "", truncated: true, hash: full.hash });
  const byteOffset =
    Buffer.byteLength(full.text.slice(0, full.text.indexOf("日本語"))) + 1;
  const partial = await stagedDiff(dir, env, byteOffset);
  expect(partial.text).not.toContain("�");
  expect(Buffer.byteLength(partial.text)).toBeLessThanOrEqual(byteOffset);
});
it("caps a large diff without losing its complete hash", async () => {
  stage("x".repeat(1_100_000));
  const result = await stagedDiff(dir, env, 64);
  expect(Buffer.byteLength(result.text)).toBe(64);
  expect(result.truncated).toBe(true);
  expect(result.hash).toBe((await stagedDiff(dir, env, 0)).hash);
});
it("--run commits a literal argv message and streams git output", async () => {
  stage();
  const diff = await stagedDiff(dir, env, 50);
  const message = "feat: don't expand $(touch sentinel)\n\n日本語🙂";
  const output: string[] = [];
  await runCommit(
    dir,
    env,
    message,
    diff.hash,
    new AbortController().signal,
    (text) => output.push(text),
  );
  expect(git("log", "-1", "--format=%B").trimEnd()).toBe(message);
  expect(output.join("")).toContain("file changed");
  await expect(stagedDiff(dir, env, 0)).rejects.toThrow(/no staged changes/);
});
it("refuses --run if the index changed and does not retry a failing git hook", async () => {
  stage("one\n");
  const diff = await stagedDiff(dir, env, 50);
  stage("two\n");
  await expect(
    runCommit(
      dir,
      env,
      "msg",
      diff.hash,
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow(/changed while drafting/);
  writeFileSync(
    join(dir, ".git", "hooks", "pre-commit"),
    "#!/bin/sh\necho hook-refused >&2\nexit 1\n",
    { mode: 0o700 },
  );
  const current = await stagedDiff(dir, env, 50);
  const output: string[] = [];
  await expect(
    runCommit(
      dir,
      env,
      "msg",
      current.hash,
      new AbortController().signal,
      (text) => output.push(text),
    ),
  ).rejects.toThrow(/git commit failed/);
  expect(output.join("")).toContain("hook-refused");
  expect((await stagedDiff(dir, env, 50)).hash).toBe(current.hash);
});
it("honors cancellation before a diff or a direct commit", async () => {
  stage();
  await expect(
    stagedDiff(dir, env, 50, AbortSignal.abort()),
  ).rejects.toMatchObject({ name: "AbortError" });
  const diff = await stagedDiff(dir, env, 50);
  await expect(
    runCommit(dir, env, "msg", diff.hash, AbortSignal.abort(), () => {}),
  ).rejects.toMatchObject({ name: "AbortError" });
});
