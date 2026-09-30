import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  cacheCommands,
  cachedCommands,
  commandAlias,
  commandPrompt,
} from "../../src/client/agent-commands.js";
import { resolvePaths } from "../../src/core/paths.js";
const id = "c_01ARZ3NDEKTSV4RRFFQ69G5FAV";
let home: string;
let paths: ReturnType<typeof resolvePaths>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-command-cache-"));
  paths = resolvePaths({
    home,
    env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
  });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});
it("caches only help data and accepts only valid identifiers and command shapes", async () => {
  const command = {
    name: "skill:review",
    kind: "skill" as const,
    description: "Review",
  };
  expect(commandAlias(command)).toBe("review");
  expect(commandPrompt(command, "file")).toBe("/skill:review file");
  expect(commandPrompt({ name: "explain", kind: "template" }, "")).toBe(
    "/explain",
  );
  await cacheCommands(paths, id, [command]);
  expect(await cachedCommands(paths, id)).toEqual([command]);
  expect(
    JSON.parse(
      readFileSync(join(paths.runtimeDir, "commands", `${id}.json`), "utf8"),
    ),
  ).toEqual([command]);
  await cacheCommands(paths, "../../invalid", [command]);
  expect(await cachedCommands(paths, "../../invalid")).toEqual([]);
  const file = join(paths.runtimeDir, "commands", `${id}.json`);
  for (const value of [null, {}, "broken JSON"]) {
    writeFileSync(
      file,
      typeof value === "string" ? value : JSON.stringify(value),
    );
    expect(await cachedCommands(paths, id)).toEqual([]);
  }
  writeFileSync(
    file,
    JSON.stringify([
      null,
      { name: 42 },
      { name: "bad;code", kind: "skill" },
      { name: "foo", kind: "unknown" },
      { name: "bad", kind: "skill", description: 42 },
      { name: "valid", kind: "extension" },
      command,
    ]),
  );
  expect(await cachedCommands(paths, id)).toEqual([
    { name: "valid", kind: "extension" },
    command,
  ]);
});
it("treats missing or unwritable metadata as optional", async () => {
  expect(await cachedCommands(paths, id)).toEqual([]);
  mkdirSync(paths.runtimeDir, { recursive: true });
  writeFileSync(join(paths.runtimeDir, "commands"), "not a directory");
  await expect(cacheCommands(paths, id, [])).resolves.toBeUndefined();
});
