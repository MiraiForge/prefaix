// The file a shell plugin reads with builtins after a turn (DESIGN §4.1.0).
//
// It is read on the prompt path, which is a hard 0-process budget, so it is
// plain text written atomically: a shell that reads it while prefaix is
// rewriting it must see the old file or the new one, never half of either.

import { readFile, writeFile } from "node:fs/promises";
import { shellRuntimeFiles } from "../core/paths.js";
import type { PrefaixPaths } from "../core/paths.js";
import { writeShellStatus } from "../core/status-file.js";

/** What the right prompt shows after a turn. */
export const STATUS_TEXT = {
  running: "⟳ running",
  done: "✓ done",
  error: "✗ error",
} as const;

export type ShellStatus = keyof typeof STATUS_TEXT;

// The file holds the display text, because that is what the plugin reads with
// builtins; the API speaks the status name, because that is what the daemon
// thinks in.
const BY_TEXT = new Map<string, ShellStatus>(
  (Object.entries(STATUS_TEXT) as [ShellStatus, string][]).map(
    ([status, text]) => [text, status],
  ),
);

export interface StatusFiles {
  writeStatus(shellId: string, status: ShellStatus): Promise<void>;
  readStatus(shellId: string): Promise<ShellStatus | undefined>;
  clearStatus(shellId: string): Promise<void>;
}

export function createStatusFiles(paths: PrefaixPaths): StatusFiles {
  const file = (shellId: string) => shellRuntimeFiles(paths, shellId).status;
  return {
    async writeStatus(shellId, status) {
      await writeShellStatus(paths, shellId, STATUS_TEXT[status]);
    },
    async readStatus(shellId) {
      try {
        const text = (await readFile(file(shellId), "utf8")).trim();
        return BY_TEXT.get(text);
      } catch {
        // No file is the normal state for a shell that has not run a turn.
        return undefined;
      }
    },
    async clearStatus(shellId) {
      await writeFile(file(shellId), "", { mode: 0o600 }).catch(
        () => undefined,
      );
    },
  };
}
