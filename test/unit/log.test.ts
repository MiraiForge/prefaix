import { describe, expect, it } from "vitest";
import {
  createLogger,
  formatLogLine,
  logLevelFromEnv,
  type LoggerOptions,
} from "../../src/core/log.js";

const TIME = new Date("2026-09-25T12:00:00.000Z");

function capture(options: LoggerOptions = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    now: () => TIME,
    write: (line) => lines.push(line),
    ...options,
  });
  return { lines, logger };
}

describe("logger", () => {
  it("writes one timestamped line per record with key=value fields", () => {
    const { lines, logger } = capture({ scope: "daemon" });
    logger.info("listening", { pid: 777, socket: "/run/user/1000/x.sock" });
    expect(lines).toEqual([
      "2026-09-25T12:00:00.000Z INFO  daemon: listening pid=777 socket=/run/user/1000/x.sock",
    ]);
  });

  it("drops records below the configured level", () => {
    const { lines, logger } = capture({ level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines).toEqual([
      "2026-09-25T12:00:00.000Z WARN  w",
      "2026-09-25T12:00:00.000Z ERROR e",
    ]);
  });

  it("defaults to info and nests child scopes", () => {
    const { lines, logger } = capture({ scope: "daemon" });
    const pool = logger.child("pool");
    pool.debug("hidden");
    pool.child("spare").info("warmed");
    createLogger({ now: () => TIME, write: (l) => lines.push(l) })
      .child("client")
      .warn("slow");
    expect(lines).toEqual([
      "2026-09-25T12:00:00.000Z INFO  daemon.pool.spare: warmed",
      "2026-09-25T12:00:00.000Z WARN  client: slow",
    ]);
  });

  it("escapes control characters so a message can't forge records", () => {
    const line = formatLogLine(
      TIME,
      "error",
      undefined,
      "child stderr\n2026-01-01T00:00:00.000Z INFO  forged",
    );
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toBe(
      '2026-09-25T12:00:00.000Z ERROR "child stderr\\n2026-01-01T00:00:00.000Z INFO  forged"',
    );
  });

  it("quotes field values that are not bare tokens", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const line = formatLogLine(TIME, "info", "t", "fields", {
      spaced: "a b",
      newline: "a\nb",
      empty: "",
      equals: "a=b",
      number: 1.5,
      missing: undefined,
      nil: null,
      list: ["x", 1],
      big: 10n,
      error: new TypeError("bad"),
      circular,
    });
    expect(line).toBe(
      "2026-09-25T12:00:00.000Z INFO  t: fields " +
        [
          'spaced="a b"',
          'newline="a\\nb"',
          'empty=""',
          'equals="a=b"',
          "number=1.5",
          "missing=undefined",
          "nil=null",
          'list=["x",1]',
          'big="10"',
          'error="TypeError: bad"',
          'circular="[object Object]"',
        ].join(" "),
    );
  });

  it.each([
    [{}, "info"],
    [{ PREFAIX_DEBUG: "" }, "info"],
    [{ PREFAIX_DEBUG: "0" }, "info"],
    [{ PREFAIX_DEBUG: "1" }, "debug"],
    [{ PREFAIX_DEBUG: "rpc" }, "debug"],
  ] as const)("reads the level from %j", (env, level) => {
    expect(logLevelFromEnv(env)).toBe(level);
  });
});
