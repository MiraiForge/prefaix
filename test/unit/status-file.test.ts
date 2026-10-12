import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolvePaths, shellRuntimeFiles } from "../../src/core/paths.js";
import { writeShellStatus } from "../../src/core/status-file.js";

let home: string;
let paths: ReturnType<typeof resolvePaths>;
const id = "1-1-a";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-status-"));
  paths = resolvePaths({
    home,
    env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
  });
});
afterEach(() => rmSync(home, { force: true, recursive: true }));
it("serializes queued atomic writes so only the last status survives, without temporary-file leaks", async () => {
  await Promise.all(
    ["running", "done", "error"].map((status) =>
      writeShellStatus(paths, id, status),
    ),
  );
  const files = shellRuntimeFiles(paths, id);
  expect(readFileSync(files.status, "utf8")).toBe("error\n");
  expect(readdirSync(files.dir)).toEqual(["status"]);
});
it("a failed queued write rejects its caller without poisoning a subsequent write", async () => {
  const files = shellRuntimeFiles(paths, id);
  mkdirSync(files.status, { recursive: true }); // rename cannot replace a directory with a file.
  const first = writeShellStatus(paths, id, "bad");
  const second = writeShellStatus(paths, id, "recovered");
  await expect(first).rejects.toThrow();
  rmSync(files.status, { force: true, recursive: true });
  await second;
  expect(readFileSync(files.status, "utf8")).toBe("recovered\n");
  expect(readdirSync(files.dir)).toEqual(["status"]);
});
it("still rejects invalid shell IDs asynchronously", async () => {
  await expect(
    writeShellStatus(paths, "../unsafe", "running"),
  ).rejects.toThrow();
});
