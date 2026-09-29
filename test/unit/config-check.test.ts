import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../../src/core/errors.js";
import { runConfigCheck } from "../../src/cli/config.js";

const FILE = "/tmp/prefaix-test/config.toml";
const HOME = "/Users/tester";

function run(text: string | undefined, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runConfigCheck({
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env,
    file: FILE,
    readFile: () => text,
    home: HOME,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("prefaix config check", () => {
  it("reports a valid file and its non-default settings", () => {
    const result = run("[pool]\nmax_children = 4\n");
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toBe(
      `config ok: ${FILE}\n\nsettings that are not defaults:\n  pool.max_children = 4  [${FILE}]`,
    );
    expect(result.err).toBe("");
  });

  it("says so when everything is a default", () => {
    const result = run("");
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toBe(
      `config ok: ${FILE}\nevery setting is at its default.`,
    );
  });

  it("works without a config file", () => {
    const result = run(undefined);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("every setting is at its default.");
  });

  it("shows env overrides as the source of a setting", () => {
    const result = run("", { PREFAIX_BACKEND: "fake" });
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain(`  agent.backend = "fake"  [PREFAIX_BACKEND]`);
  });

  it("exits 2 and points at the line on a bad file", () => {
    const result = run('[ui]\nthinking = "loud"\n');
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toContain(`${FILE}:2:1: ui.thinking:`);
    expect(result.err).toContain('thinking = "loud"');
    expect(result.err).toContain("1 problem found. Fix them");
    expect(result.out).toBe("");
  });

  it("counts every problem", () => {
    const result = run('[ui]\nthinking = "loud"\n[pool]\nspare = "yes"\n');
    expect(result.err).toContain("2 problems found");
  });

  it("reports a bad env override too", () => {
    const result = run("", { PREFAIX_POOL_MAX_CHILDREN: "lots" });
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toContain(
      "PREFAIX_POOL_MAX_CHILDREN: pool.max_children:",
    );
  });
});

describe("config check reads a real file", () => {
  it("reads the file from disk when given no reader", () => {
    const dir = mkdtempSync(join(tmpdir(), "pfx-check-"));
    const file = join(dir, "config.toml");
    writeFileSync(file, '[ui]\nrprompt = "off"\n');
    const out: string[] = [];
    const code = runConfigCheck({
      out: (line) => out.push(line),
      err: () => {},
      file,
    });
    expect(code).toBe(EXIT.ok);
    expect(out.join("\n")).toContain('ui.rprompt = "off"');
  });

  it("passes when the file does not exist at all", () => {
    const out: string[] = [];
    const code = runConfigCheck({
      out: (line) => out.push(line),
      err: () => {},
      file: join(tmpdir(), "pfx-definitely-absent.toml"),
    });
    expect(code).toBe(EXIT.ok);
    expect(out.join("\n")).toContain("every setting is at its default");
  });

  it("reports a broken file it read itself, with a caret", () => {
    const dir = mkdtempSync(join(tmpdir(), "pfx-check-"));
    const file = join(dir, "config.toml");
    writeFileSync(file, '[ui]\nthinking = "loud"\n');
    const err: string[] = [];
    const code = runConfigCheck({
      out: () => {},
      err: (line) => err.push(line),
      file,
    });
    expect(code).toBe(EXIT.usage);
    expect(err.join("\n")).toContain("ui.thinking");
    expect(err.join("\n")).toContain("^");
  });

  it("defaults the file it reports to the XDG config path", () => {
    const out: string[] = [];
    runConfigCheck({
      out: (line) => out.push(line),
      err: () => {},
      readFile: () => undefined,
    });
    // No file, no override: the reported path is still prefaix's own.
    expect(out[0]).toContain(join(".config", "prefaix", "config.toml"));
  });
});
