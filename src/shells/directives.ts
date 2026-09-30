// Directives are data, never code (DESIGN §3.1, D7, ADR 0003).
//
// The client writes a NUL-delimited key/value file and the shell plugin applies
// a fixed whitelist of keys through a whitelist. Nothing generated is ever
// evaluated, so a `buffer` value full of model-written shell code is just bytes
// that land in `BUFFER` and wait for the user to press Enter.

/** The only keys a plugin will act on (DESIGN §4.1.0). */
export const DIRECTIVE_KEYS = [
  "nonce",
  "conversation",
  "status",
  "buffer",
  "cursor",
] as const;

export type DirectiveKey = (typeof DIRECTIVE_KEYS)[number];

export function isDirectiveKey(value: string): value is DirectiveKey {
  return (DIRECTIVE_KEYS as readonly string[]).includes(value);
}

export interface Directives {
  /** Must match the nonce the client passed in, or the file is ignored. */
  nonce: string;
  conversation?: string;
  status?: string;
  /** Text to put in the prompt buffer without running it. */
  buffer?: string;
  /** Zero-based Unicode code-point offset within `buffer`; invalid or absent means end. */
  cursor?: number;
}

export type DirectiveOrder = ReadonlyArray<keyof Directives>;

/**
 * The order the file is written in. `buffer` comes after `cursor` is computed
 * from it, and a reader that applies keys in file order can therefore set both
 * without knowing anything about the shell.
 */
export const DEFAULT_ORDER: DirectiveOrder = [
  "nonce",
  "conversation",
  "status",
  "buffer",
  "cursor",
];

/**
 * Encodes directives as `key\0value\0` pairs. The NUL separator is what makes
 * arbitrary bytes safe: a value can contain newlines, spaces, quotes, and
 * NUL-free binary, and none of it can be mistaken for another key.
 */
export function encodeDirectives(
  directives: Directives,
  order: DirectiveOrder = DEFAULT_ORDER,
): Buffer {
  const parts: Buffer[] = [];
  for (const key of order) {
    const value = directives[key];
    if (value === undefined) {
      continue;
    }
    // A NUL inside a value would split the record in two and let a crafted
    // buffer smuggle a directive past the whitelist.
    const text = typeof value === "number" ? String(value) : value;
    if (text.includes("\0")) {
      throw new Error(`directive ${key} contains a NUL byte`);
    }
    parts.push(Buffer.from(`${key}\0${text}\0`, "utf8"));
  }
  return Buffer.concat(parts);
}

/**
 * Decodes a directives file. This is the reader the tests use and the shape the
 * three shell snippets in DESIGN §4.1.0 produce; an odd number of fields is a
 * truncated file and is reported rather than half-applied.
 */
export function decodeDirectives(
  bytes: Buffer | string,
): Directives | undefined {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const fields = buffer.toString("utf8").split("\0");
  // Every pair ends with a separator, so a well-formed file ends with an empty
  // field.
  if (fields.at(-1) !== "") {
    return undefined;
  }
  fields.pop();
  if (fields.length % 2 !== 0) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (let at = 0; at < fields.length; at += 2) {
    // The length is even and the loop stops at it, so both halves of every
    // pair are there.
    const key = fields[at] as string;
    const value = fields[at + 1] as string;
    if (!isDirectiveKey(key)) {
      // An unknown key is ignored, not an error: a newer client may write one
      // and an older plugin must simply not act on it.
      continue;
    }
    out[key] = value;
  }
  const nonce = out["nonce"];
  if (nonce === undefined) {
    return undefined;
  }
  const cursorField = out["cursor"];
  const cursor =
    cursorField === undefined ? Number.NaN : Number.parseInt(cursorField, 10);
  return {
    nonce,
    ...(out["conversation"] === undefined
      ? {}
      : { conversation: out["conversation"] }),
    ...(out["status"] === undefined ? {} : { status: out["status"] }),
    ...(out["buffer"] === undefined ? {} : { buffer: out["buffer"] }),
    // A cursor that is not a number is left out rather than written as NaN,
    // which a shell would take literally.
    ...(Number.isInteger(cursor) ? { cursor } : {}),
  };
}

/** True when a file's nonce matches the one the client passed to the shell. */
export function nonceMatches(
  directives: Directives | undefined,
  expected: string,
): boolean {
  return directives !== undefined && directives.nonce === expected;
}

/**
 * What the shell should do with the buffer it was handed. `run` refreshes the
 * prompt and re-runs precmd, so the shell redraws with the agent's edits; `edit`
 * waits for the user.
 */
export function bufferAction(
  directives: Directives | undefined,
): "run" | "edit" {
  return directives?.buffer === undefined || directives.buffer === ""
    ? "run"
    : "edit";
}
