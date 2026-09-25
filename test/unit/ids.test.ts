import { describe, expect, it } from "vitest";
import {
  createRequestIds,
  createUlidFactory,
  isConversationId,
  isShellId,
  isTurnId,
  newConversationId,
  newTurnId,
  ULID_PATTERN,
  ulid,
  ulidTime,
} from "../../src/core/ids.js";

// Reference timestamp from the ULID spec: 1469918176385 → "01ARYZ6S41".
const SPEC_TIME = 1469918176385;

function factory(times: number[], byte = 0) {
  return createUlidFactory({
    now: () => {
      const time = times.shift();
      if (time === undefined) throw new Error("clock exhausted");
      return time;
    },
    random: (bytes) => bytes.fill(byte),
  });
}

describe("ULIDs", () => {
  it("encodes time and randomness in Crockford base32", () => {
    expect(factory([SPEC_TIME], 0x00)()).toBe("01ARYZ6S410000000000000000");
    expect(factory([SPEC_TIME], 0xff)()).toBe("01ARYZ6S41ZZZZZZZZZZZZZZZZ");
    expect(factory([0])()).toBe("00000000000000000000000000");
    expect(factory([2 ** 48 - 1], 0xff)()).toBe("7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
  });

  it("increments the random part within one millisecond", () => {
    const next = factory([SPEC_TIME, SPEC_TIME, SPEC_TIME + 1]);
    expect(next()).toBe("01ARYZ6S410000000000000000");
    expect(next()).toBe("01ARYZ6S410000000000000001");
    expect(next()).toBe("01ARYZ6S420000000000000000");
  });

  it("stays monotonic when the clock steps backwards", () => {
    const next = factory([SPEC_TIME, SPEC_TIME - 5000]);
    const first = next();
    const second = next();
    expect(second > first).toBe(true);
    expect(ulidTime(second)).toBe(SPEC_TIME);
  });

  it("refuses to wrap the random part", () => {
    const next = factory([SPEC_TIME, SPEC_TIME], 0xff);
    next();
    expect(() => next()).toThrow(RangeError);
  });

  it.each([-1, 2 ** 48, 1.5, Number.NaN])("rejects time %s", (time) => {
    expect(() => factory([time])()).toThrow(RangeError);
  });

  it("decodes the timestamp", () => {
    expect(ulidTime("01ARYZ6S41TSV4RRFFQ69G5FAV")).toBe(SPEC_TIME);
    expect(() => ulidTime("01ARYZ6S41TSV4RRFFQ69G5FAU!")).toThrow(TypeError);
    expect(() => ulidTime("81ARYZ6S41TSV4RRFFQ69G5FAV")).toThrow(TypeError);
  });

  it("generates unique ids that sort in creation order", () => {
    const ids = Array.from({ length: 2000 }, () => ulid());
    for (const id of ids) {
      expect(id).toMatch(ULID_PATTERN);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(Math.abs(ulidTime(ids[0] ?? "") - Date.now())).toBeLessThan(60_000);
  });
});

describe("prefixed ids", () => {
  it("mints conversation and turn ids", () => {
    const conversation = newConversationId();
    const turn = newTurnId();
    expect(conversation).toMatch(/^c_[0-9A-Z]{26}$/);
    expect(turn).toMatch(/^t_[0-9A-Z]{26}$/);
    expect(isConversationId(conversation)).toBe(true);
    expect(isTurnId(turn)).toBe(true);
    expect(isConversationId(turn)).toBe(false);
    expect(isTurnId(conversation)).toBe(false);
  });

  it.each([
    "c_01ARYZ6S41TSV4RRFFQ69G5FA",
    "c_01ARYZ6S41TSV4RRFFQ69G5FAVX",
    "c_01ARYZ6S41TSV4RRFFQ69G5FAI",
    "c_01aryz6s41tsv4rrffq69g5fav",
    "C_01ARYZ6S41TSV4RRFFQ69G5FAV",
    "c_../../../../etc/passwd",
    "c_01ARYZ6S41TSV4RRFFQ69G5FAV\n",
    42,
    null,
  ])("rejects conversation id %j", (value) => {
    expect(isConversationId(value)).toBe(false);
  });

  it.each(["4242-1758800000-a1B2", "1-0-x", "99999-1758800000123-Zz09"])(
    "accepts shell id %j",
    (value) => {
      expect(isShellId(value)).toBe(true);
    },
  );

  it.each([
    "0-1758800000-a",
    "4242--a",
    "4242-1758800000-",
    "4242-1758800000-a/b",
    "4242-1758800000-..",
    "4242-1758800000-a b",
    `4242-1758800000-${"a".repeat(33)}`,
    "../4242-1-a",
    undefined,
  ])("rejects shell id %j", (value) => {
    expect(isShellId(value)).toBe(false);
  });

  it("numbers requests per connection", () => {
    const first = createRequestIds();
    const second = createRequestIds();
    expect([first(), first(), first()]).toEqual(["r1", "r2", "r3"]);
    expect(second()).toBe("r1");
  });
});
