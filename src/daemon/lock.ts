// The daemon lock (DESIGN §4.3.1). Exactly one daemon per user, so the lock is
// the thing that makes `prefaix run` safe to invoke from three shells at once:
// one client takes it, spawns the daemon, and the rest discover a live daemon
// through the socket instead.
//
// A lock whose pid is dead is stale by definition — the process that wrote it
// cannot be taking it — so it is removed rather than waited on. A lock held by
// a live process that is simply slow to write its socket is not stolen, because
// two daemons writing the same conversations is far worse than a short wait.

import { open, readFile, unlink } from "node:fs/promises";
import { PrefaixError } from "../core/errors.js";

export interface LockHandle {
  readonly path: string;
  readonly pid: number;
  release(): Promise<void>;
}

export interface TryLockOptions {
  readonly path: string;
  readonly pid?: number;
  /** Injected so a test can decide what a stale lock looks like. */
  readonly isAlive?: (pid: number) => boolean;
}

export class LockHeldError extends PrefaixError {
  constructor(
    readonly heldBy: number,
    readonly path: string,
  ) {
    super(
      "DAEMON_UNAVAILABLE",
      `another prefaix daemon is starting (lock held by pid ${String(heldBy)})`,
      {
        hint: "Wait a moment and retry. prefaix daemon --foreground shows its log.",
      },
    );
  }
}

function processIsAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to someone else, which for a
    // lock in a 0700 directory cannot happen and still counts as alive.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readPid(file: string): Promise<number | undefined> {
  try {
    const text = (await readFile(file, "utf8")).trim();
    const pid = Number.parseInt(text, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes the lock, or throws `LockHeldError` when a live process holds it. A
 * leftover lock is removed on the way in, which is what makes a crash of the
 * daemon a non-event for the next `:`.
 */
export async function tryLock(options: TryLockOptions): Promise<LockHandle> {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const { path } = options;

  // Two passes: a leftover lock is common enough that the first attempt
  // clearing it and the second taking it is cheaper than any inter-process
  // mutex would be here, and the window between them is the same one the
  // daemon itself uses to bind the socket.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${String(pid)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return {
        path,
        pid,
        release: async () => {
          // Only removed when it is still ours: a daemon that was replaced
          // must not delete the new one's lock on its way out.
          if ((await readPid(path)) === pid) {
            await unlink(path).catch(() => undefined);
          }
        },
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
    }
    const heldBy = await readPid(path);
    if (heldBy !== undefined && isAlive(heldBy)) {
      throw new LockHeldError(heldBy, path);
    }
    await unlink(path).catch(() => undefined);
  }
  throw new PrefaixError(
    "DAEMON_UNAVAILABLE",
    `could not take the daemon lock at ${path}`,
    { hint: "If no daemon is running, delete the file and retry." },
  );
}

export async function readLockPid(file: string): Promise<number | undefined> {
  return readPid(file);
}

export async function lockIsStale(
  file: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<boolean> {
  const pid = await readPid(file);
  return pid === undefined || !isAlive(pid);
}
