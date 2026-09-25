import { randomFillSync } from "node:crypto";

// Identifiers from DESIGN §5: conversation `c_<ULID>`, turn `t_<ULID>`,
// request `r<n>`, and shell `<pid>-<epoch>-<rand>`. Conversation and shell ids
// become file names, so anything read from the wire, argv, or disk must pass
// the matching validator before it touches a path.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10;
const MAX_TIME = 2 ** 48 - 1;
const RANDOM_LIMIT = 1n << 80n;

const ULID_BODY = "[0-7][0-9A-HJKMNP-TV-Z]{25}";

export const ULID_PATTERN = new RegExp(`^${ULID_BODY}$`);
export const SHELL_ID_PATTERN =
  /^[1-9][0-9]{0,9}-[0-9]{1,16}-[A-Za-z0-9]{1,32}$/;

const CONVERSATION_ID_PATTERN = new RegExp(`^c_${ULID_BODY}$`);
const TURN_ID_PATTERN = new RegExp(`^t_${ULID_BODY}$`);

function encodeTime(time: number): string {
  let out = "";
  for (let i = 0; i < TIME_CHARS; i++) {
    out = CROCKFORD.charAt(time % 32) + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(value: bigint): string {
  let out = "";
  for (let i = 0; i < RANDOM_CHARS; i++) {
    out = CROCKFORD.charAt(Number(value & 31n)) + out;
    value >>= 5n;
  }
  return out;
}

export interface UlidFactoryOptions {
  now?: () => number;
  random?: (bytes: Uint8Array) => void;
}

// Monotonic within a process: ids minted in the same millisecond, or while the
// clock steps backwards, reuse the last timestamp and increment the random
// part, so sorting ids by string always matches creation order.
export function createUlidFactory(
  options: UlidFactoryOptions = {},
): () => string {
  const now = options.now ?? Date.now;
  const fill = options.random ?? ((bytes: Uint8Array) => randomFillSync(bytes));
  let lastTime = -1;
  let lastRandom = 0n;
  return () => {
    const time = now();
    if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
      throw new RangeError(`ULID time out of range: ${time}`);
    }
    if (time <= lastTime) {
      lastRandom += 1n;
      if (lastRandom >= RANDOM_LIMIT) {
        throw new RangeError("ULID random component overflowed");
      }
    } else {
      const bytes = new Uint8Array(RANDOM_BYTES);
      fill(bytes);
      lastTime = time;
      lastRandom = bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
    }
    return encodeTime(lastTime) + encodeRandom(lastRandom);
  };
}

export const ulid = createUlidFactory();

export function ulidTime(id: string): number {
  if (!ULID_PATTERN.test(id)) {
    throw new TypeError(`Not a ULID: ${id}`);
  }
  let time = 0;
  for (const char of id.slice(0, TIME_CHARS)) {
    time = time * 32 + CROCKFORD.indexOf(char);
  }
  return time;
}

export function newConversationId(): string {
  return `c_${ulid()}`;
}

export function newTurnId(): string {
  return `t_${ulid()}`;
}

export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
}

export function isTurnId(value: unknown): value is string {
  return typeof value === "string" && TURN_ID_PATTERN.test(value);
}

export function isShellId(value: unknown): value is string {
  return typeof value === "string" && SHELL_ID_PATTERN.test(value);
}

// Request ids are only unique per connection, so each connection owns a
// counter.
export function createRequestIds(): () => string {
  let next = 0;
  return () => `r${++next}`;
}
