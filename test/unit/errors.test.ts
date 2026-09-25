import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ERROR_CODES,
  EXIT,
  exitCodeFor,
  isErrorCode,
  PrefaixError,
  toErrorInfo,
  unsupported,
  type ErrorCode,
} from "../../src/core/errors.js";
import { err, ok, type Result } from "../../src/core/result.js";

describe("error codes", () => {
  // DESIGN §4.2: 0 ok · 1 agent error · 2 usage or unknown command ·
  // 3 daemon unavailable · 4 agent unavailable · 130 aborted.
  it.each([
    ["USAGE", 2],
    ["UNKNOWN_COMMAND", 2],
    ["UNSUPPORTED", 2],
    ["CONFIG_INVALID", 2],
    ["DAEMON_UNAVAILABLE", 3],
    ["PROTOCOL_MISMATCH", 3],
    ["AGENT_UNAVAILABLE", 4],
    ["AGENT_ERROR", 1],
    ["CONVERSATION_BUSY", 1],
    ["CONVERSATION_NOT_FOUND", 1],
    ["ABORTED", 130],
    ["INTERNAL", 1],
  ] as const)("%s exits %i", (code, exit) => {
    expect(exitCodeFor(code)).toBe(exit);
  });

  it("maps every code and nothing else", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) {
      expect(Object.values(EXIT)).toContain(exitCodeFor(code));
    }
    expect(isErrorCode("AGENT_UNAVAILABLE")).toBe(true);
    expect(isErrorCode("agent_unavailable")).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
  });
});

describe("PrefaixError", () => {
  it("carries a code, hint, cause, and exit status", () => {
    const cause = new Error("spawn pi ENOENT");
    const error = new PrefaixError(
      "AGENT_UNAVAILABLE",
      "pi not found on PATH",
      {
        hint: "prefaix doctor",
        cause,
      },
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PrefaixError");
    expect(error.code).toBe("AGENT_UNAVAILABLE");
    expect(error.hint).toBe("prefaix doctor");
    expect(error.cause).toBe(cause);
    expect(error.exitCode).toBe(4);
  });

  it("serializes to the wire error shape", () => {
    expect(
      new PrefaixError("AGENT_UNAVAILABLE", "pi not found on PATH", {
        hint: "prefaix doctor",
      }).toInfo(),
    ).toStrictEqual({
      code: "AGENT_UNAVAILABLE",
      message: "pi not found on PATH",
      hint: "prefaix doctor",
    });
    const bare = new PrefaixError("CONVERSATION_BUSY", "busy").toInfo();
    expect(bare).toStrictEqual({ code: "CONVERSATION_BUSY", message: "busy" });
    expect(JSON.stringify(bare)).toBe(
      '{"code":"CONVERSATION_BUSY","message":"busy"}',
    );
  });

  it("round-trips through the wire and distrusts unknown codes", () => {
    const info = {
      code: "CONVERSATION_BUSY",
      message: "busy",
      hint: ":attach",
    };
    expect(PrefaixError.fromInfo(info).toInfo()).toStrictEqual(info);
    const future = PrefaixError.fromInfo({ code: "QUOTA", message: "later" });
    expect(future.code).toBe("INTERNAL");
    expect(future.message).toBe("later");
  });

  it("normalizes unknown throwables to INTERNAL", () => {
    expect(toErrorInfo(new PrefaixError("ABORTED", "aborted"))).toStrictEqual({
      code: "ABORTED",
      message: "aborted",
    });
    expect(toErrorInfo(new TypeError("boom"))).toStrictEqual({
      code: "INTERNAL",
      message: "boom",
    });
    expect(toErrorInfo("plain")).toStrictEqual({
      code: "INTERNAL",
      message: "plain",
    });
  });

  it("reports a missing capability as a usage error, not a crash", () => {
    const error = unsupported("pi", ":think");
    expect(error.code).toBe("UNSUPPORTED");
    expect(error.message).toBe(":think isn't supported by pi");
    expect(error.exitCode).toBe(2);
  });
});

describe("Result", () => {
  function parsePort(text: string): Result<number> {
    const port = Number(text);
    return Number.isInteger(port)
      ? ok(port)
      : err(new PrefaixError("USAGE", `bad port: ${text}`));
  }

  it("narrows on ok", () => {
    const good = parsePort("8080");
    const bad = parsePort("x");
    expect(good).toStrictEqual({ ok: true, value: 8080 });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("expected failure");
    expectTypeOf(bad.error).toEqualTypeOf<PrefaixError>();
    expectTypeOf(bad.error.code).toEqualTypeOf<ErrorCode>();
    expect(bad.error.message).toBe("bad port: x");
  });
});
