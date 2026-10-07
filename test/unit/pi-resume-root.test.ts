import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertResumeRoot } from "../../src/agents/pi/resume-root.js";
import { createPiAdapter } from "../../src/agents/pi/adapter.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function setup(header?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "pfx-resume-root-"));
  dirs.push(dir);
  const a = join(dir, "A"),
    b = join(dir, "B"),
    file = join(dir, "session.jsonl");
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(
    file,
    JSON.stringify(header ?? { type: "session", cwd: a }) +
      "\n" +
      "x".repeat(100_000),
  );
  return { dir, a, b, file };
}
describe("S3 native resume root safety", () => {
  it("allows same-root and canonical symlink aliases", async () => {
    const s = setup();
    await assertResumeRoot(s.file, s.a);
    const alias = join(s.dir, "alias");
    symlinkSync(s.a, alias, "dir");
    await assertResumeRoot(s.file, alias);
  });
  it("refuses cross-root resume before spawning or prompting", async () => {
    const s = setup();
    const spawn = vi.fn();
    await expect(
      createPiAdapter({ rpc: { spawn } }).open({
        root: s.b,
        env: {},
        resume: { sessionFile: s.file },
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      hint: expect.stringContaining('"split"'),
    });
    expect(spawn).not.toHaveBeenCalled();
  });
  it("leaves undefined, empty and absent native files to pi diagnostics", async () => {
    const s = setup();
    await assertResumeRoot(undefined, s.b);
    await assertResumeRoot("", s.b);
    await assertResumeRoot(join(s.dir, "absent"), s.b);
  });
  it.each([null, {}, { cwd: "" }, { cwd: 4 }])(
    "refuses an unverifiable header %j",
    async (header) => {
      const s = setup();
      writeFileSync(s.file, JSON.stringify(header));
      await expect(assertResumeRoot(s.file, s.a)).rejects.toMatchObject({
        code: "AGENT_ERROR",
      });
    },
  );
  it("bounds header reads and never exposes raw header contents in errors", async () => {
    const s = setup();
    for (const raw of ["invalid-private-header", "x".repeat(70_000)]) {
      writeFileSync(s.file, raw);
      await expect(assertResumeRoot(s.file, s.a)).rejects.toMatchObject({
        code: "AGENT_ERROR",
        message: "Cannot verify the pi session directory from its header.",
      });
    }
  });
  it("reports read-open errors cleanly and handles a missing original directory", async () => {
    const s = setup();
    await expect(
      assertResumeRoot(join(s.file, "not-a-file"), s.a),
    ).rejects.toMatchObject({ code: "AGENT_ERROR" });
    writeFileSync(s.file, JSON.stringify({ cwd: resolve(s.dir, "gone") }));
    await expect(assertResumeRoot(s.file, s.b)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await assertResumeRoot(s.file, resolve(s.dir, "gone"));
  });
});
