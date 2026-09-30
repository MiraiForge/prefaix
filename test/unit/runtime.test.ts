import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STATUS_TEXT, createStatusFiles } from "../../src/daemon/status.js";
import { resolvePaths, shellRuntimeFiles } from "../../src/core/paths.js";
import { writeShellStatus } from "../../src/core/status-file.js";
import {
  VOLATILE_ENV,
  envFingerprint,
  envKeys,
  filterEnv,
} from "../../src/context/env.js";
import {
  OPERATION_NAMES,
  PROTOCOL_VERSION,
  encodeRecord,
  isOperationName,
  parseClientRecord,
  parseDaemonRecord,
  splitRecords,
} from "../../src/core/protocol.js";
import {
  compilePattern,
  isCompilablePattern,
  splitInlineFlags,
} from "../../src/core/pattern.js";

const SHELL_ID = "1-1-a";

let home = "";
let paths: ReturnType<typeof resolvePaths>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-runtime-"));
  // A short runtime dir under the temp home, so this suite never lands in the
  // shared /tmp fallback the sun_path limit forces on a deep temp path.
  paths = resolvePaths({
    env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
    home,
  });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the status file a prompt reads with builtins", () => {
  it("writes the text the plugin shows on the right prompt", async () => {
    const status = createStatusFiles(paths);
    await status.writeStatus(SHELL_ID, "running");
    expect(await status.readStatus(SHELL_ID)).toBe("running");
    await status.writeStatus(SHELL_ID, "done");
    expect(await status.readStatus(SHELL_ID)).toBe("done");
    await status.writeStatus(SHELL_ID, "error");
    expect(await status.readStatus(SHELL_ID)).toBe("error");
  });

  it("is 0600 and written atomically, so a prompt never reads half of it", async () => {
    const status = createStatusFiles(paths);
    await status.writeStatus(SHELL_ID, "done");
    const file = join(paths.shellsDir, SHELL_ID, "status");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await status.readStatus(SHELL_ID)).toBe("done");
  });

  it("reads as no status before the shell has run a turn", async () => {
    expect(await createStatusFiles(paths).readStatus(SHELL_ID)).toBeUndefined();
  });

  it("publishes complete rich status across concurrent writers without temporary files", async () => {
    const labels = ["prefaix · fake-fast · idle", "prefaix · error"];
    await Promise.all(
      labels.map((label) => writeShellStatus(paths, SHELL_ID, label)),
    );
    const { dir, status } = shellRuntimeFiles(paths, SHELL_ID);
    expect(labels).toContain((await readFile(status, "utf8")).trim());
    expect(await readdir(dir)).toEqual(["status"]);
    expect((await stat(status)).mode & 0o777).toBe(0o600);
  });

  it("validates shell ids and removes temporary files when publication fails", async () => {
    await expect(
      writeShellStatus(paths, "../outside", "status"),
    ).rejects.toThrow("Invalid shell id");
    const { dir, status } = shellRuntimeFiles(paths, SHELL_ID);
    await mkdir(status, { recursive: true });
    await expect(writeShellStatus(paths, SHELL_ID, "status")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["status"]);
  });

  it("reads an unrecognized file as no status rather than guessing", async () => {
    const status = createStatusFiles(paths);
    await status.writeStatus(SHELL_ID, "done");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(paths.shellsDir, SHELL_ID, "status"),
      "something else\n",
    );
    expect(await status.readStatus(SHELL_ID)).toBeUndefined();
  });

  it("clears to an empty file rather than leaving a stale answer", async () => {
    const status = createStatusFiles(paths);
    await status.writeStatus(SHELL_ID, "error");
    await status.clearStatus(SHELL_ID);
    expect(await status.readStatus(SHELL_ID)).toBeUndefined();
  });

  it("uses one word per state, because a prompt has no room for prose", () => {
    expect(Object.values(STATUS_TEXT)).toEqual([
      "⟳ running",
      "✓ done",
      "✗ error",
    ]);
  });
});

describe("the environment the child inherits", () => {
  const policy = {
    passthrough: "all" as const,
    allowlist: null,
    deny: ["PREFAIX_*", "PWD", "_"],
  };

  it("passes everything but the denied names", () => {
    const filtered = filterEnv(
      {
        PATH: "/usr/bin",
        HOME: "/h",
        PWD: "/h/x",
        PREFAIX_BACKEND: "fake",
        _: "/bin/zsh",
      },
      policy,
    );
    expect(filtered).toEqual({ PATH: "/usr/bin", HOME: "/h" });
  });

  it("matches a deny entry that ends in a star as a prefix", () => {
    expect(filterEnv({ PREFAIX_SHELL_ID: "1", PREFAIXX: "1" }, policy)).toEqual(
      { PREFAIXX: "1" },
    );
  });

  it("passes only the allowlist when one is configured", () => {
    const filtered = filterEnv(
      { PATH: "/usr/bin", HOME: "/h", SECRET_TOKEN: "s" },
      { passthrough: "allowlist", allowlist: ["PATH"], deny: [] },
    );
    expect(filtered).toEqual({ PATH: "/usr/bin" });
  });

  it("drops a name with no value rather than passing undefined", () => {
    expect(filterEnv({ PATH: "/usr/bin", MISSING: undefined }, policy)).toEqual(
      { PATH: "/usr/bin" },
    );
  });
});

describe("the environment fingerprint", () => {
  it("is stable for the same environment in a different order", () => {
    expect(envFingerprint({ A: "1", B: "2" })).toBe(
      envFingerprint({ B: "2", A: "1" }),
    );
  });

  it("changes when a value changes", () => {
    expect(envFingerprint({ PATH: "/a" })).not.toBe(
      envFingerprint({ PATH: "/b" }),
    );
  });

  it("ignores the keys that change on every prompt", () => {
    const base = { PATH: "/usr/bin" };
    for (const key of VOLATILE_ENV) {
      expect(envFingerprint({ ...base, [key]: "x" })).toBe(
        envFingerprint(base),
      );
    }
  });

  it("does not confuse a key boundary with a value", () => {
    // "A=x B" and "A=xB" must not hash the same, which a naive concatenation
    // would happily do.
    expect(envFingerprint({ A: "x B" })).not.toBe(envFingerprint({ A: "xB" }));
  });

  it("lists keys, for a debug log that never prints values", () => {
    expect(envKeys({ B: "2", A: "1" })).toEqual(["A", "B"]);
  });
});

describe("the wire format", () => {
  it("splits on LF and keeps a trailing partial record", () => {
    expect(splitRecords('{"a":1}\n{"b":2}')).toEqual({
      lines: ['{"a":1}'],
      rest: '{"b":2}',
    });
  });

  it("strips a trailing CR, because some writers send one", () => {
    expect(splitRecords('{"a":1}\r\n').lines).toEqual(['{"a":1}']);
  });

  it("keeps a U+2028 inside a record, which readline would not", () => {
    const line =
      '{"t":"req","id":"r1","op":"turn.start","params":{"text":"a\u2028b"}}';
    const { lines } = splitRecords(`${line}\n`);
    const record = parseClientRecord(lines[0] ?? "");
    expect((record as { params: { text: string } }).params.text).toBe(
      "a\u2028b",
    );
  });

  it("round-trips a message through encode and parse", () => {
    const message = {
      t: "hello",
      v: PROTOCOL_VERSION,
      version: "1",
      pid: 7,
    } as const;
    const { lines } = splitRecords(encodeRecord(message));
    expect(parseDaemonRecord(lines[0] ?? "")).toEqual(message);
  });

  it("refuses a line that is not a message it defines", () => {
    for (const line of ["", "   ", "not json", "[1,2]", '"a string"', "null"]) {
      expect(parseClientRecord(line)).toBeUndefined();
      expect(parseDaemonRecord(line)).toBeUndefined();
    }
  });

  it("refuses a request for an operation it does not have", () => {
    // Answering an operation this build does not know would be a guess at what
    // the caller meant, so the line is dropped instead.
    expect(
      parseClientRecord('{"t":"req","id":"r1","op":"turn.rewind","params":{}}'),
    ).toBeUndefined();
  });

  it("refuses a message meant for the other end of the socket", () => {
    expect(
      parseClientRecord('{"t":"res","id":"r1","ok":true}'),
    ).toBeUndefined();
    expect(
      parseDaemonRecord('{"t":"req","id":"r1","op":"turn.start"}'),
    ).toBeUndefined();
  });

  it("knows every operation it advertises", () => {
    expect(OPERATION_NAMES.length).toBeGreaterThan(10);
    for (const op of OPERATION_NAMES) {
      expect(isOperationName(op)).toBe(true);
    }
    expect(isOperationName("nope")).toBe(false);
    expect(isOperationName(7)).toBe(false);
  });
});

describe("user patterns", () => {
  it("lifts a leading inline flag group into the flags", () => {
    expect(splitInlineFlags("(?i)token")).toEqual({
      source: "token",
      flags: "i",
    });
  });

  it("refuses a flag JavaScript has no equivalent for", () => {
    const split = splitInlineFlags("(?x)token");
    expect(split.problem).toBe("unsupported flag(s): x");
    expect(compilePattern("(?x)token")).toBeUndefined();
  });

  it("compiles the (?i) spelling DESIGN §6 documents", () => {
    expect(isCompilablePattern("(?i)internal-token-[a-z0-9]+")).toBe(true);
    const pattern = compilePattern("(?i)abc");
    expect(pattern?.flags).toContain("i");
  });

  it("keeps a mid-pattern group where the compiler will reject it", () => {
    // `a(?i)b` is a real mistake, not a spelling to be rescued.
    expect(compilePattern("a(?i)b")).toBeUndefined();
  });

  it("keeps the caller's global flag so a shared pattern stays usable", () => {
    expect(compilePattern("a")?.flags).toContain("g");
    expect(compilePattern("a", "")?.flags).not.toContain("g");
  });
});
