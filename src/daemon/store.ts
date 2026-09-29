// prefaix's own conversation index (DESIGN §4.3.5). Every adapter keeps its
// native transcript; this is the small, backend-independent record prefaix needs
// to route a `:` back to the right child, and it is written atomically so a
// crash mid-write can never leave a half-parsed file that takes the whole
// index with it.

import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { posix } from "node:path";
import { PrefaixError, messageOf } from "../core/errors.js";
import { newConversationId } from "../core/ids.js";
import { conversationFile } from "../core/paths.js";
import type { PrefaixPaths } from "../core/paths.js";
import type { ShellKind } from "../core/agent-port.js";

export interface ConversationRecord {
  id: string;
  backend: string;
  /** Adapter-owned and opaque to core; resumed verbatim by the pool. */
  native: { sessionFile?: string; sessionId?: string };
  title: string;
  root: string;
  createdAt: string;
  updatedAt: string;
  model?: { provider: string; id: string };
  thinking?: string;
  persona?: string;
  stats: { turns: number; costUsd?: number; lastContextPct?: number };
  createdBy: { shell: ShellKind; host: string };
}

const TITLE_LIMIT = 60;

export function titleFrom(prompt: string): string {
  // A leading `:` is stripped so the title reads as the question rather than as
  // the keystroke that produced it. The grammar normally removes it before the
  // text reaches the daemon, so this only matters for a title built from a raw
  // buffer.
  const newline = prompt.indexOf("\n");
  const firstLine = (newline === -1 ? prompt : prompt.slice(0, newline))
    .replace(/^:[ \t]?/u, "")
    .trim();
  const flat = firstLine.replaceAll(/\s+/gu, " ");
  return flat.length <= TITLE_LIMIT
    ? flat
    : `${flat.slice(0, TITLE_LIMIT - 1)}…`;
}
export interface CreateRecordOptions {
  readonly id?: string;
  readonly backend: string;
  readonly root: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly shell: ShellKind;
  readonly host?: string;
  readonly native?: ConversationRecord["native"];
  readonly now?: () => Date;
}

export function newRecord(options: CreateRecordOptions): ConversationRecord {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const record: ConversationRecord = {
    id: options.id ?? newConversationId(),
    backend: options.backend,
    native: options.native ?? {},
    title:
      options.title ??
      (options.prompt === undefined || options.prompt === ""
        ? "new conversation"
        : titleFrom(options.prompt)),
    root: options.root,
    createdAt: now,
    updatedAt: now,
    stats: { turns: 0 },
    createdBy: { shell: options.shell, host: options.host ?? hostname() },
  };
  return record;
}

function isRecord(value: unknown): value is ConversationRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<ConversationRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.backend === "string" &&
    typeof record.title === "string" &&
    typeof record.root === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    typeof record.stats === "object" &&
    record.stats !== null
  );
}

export interface StoreOptions {
  readonly paths: PrefaixPaths;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The on-disk index. Writes go to a temp file in the same directory, are
 * fsynced, and are renamed over the target, so a reader never sees a partial
 * record and a crash leaves either the old file or the new one.
 */
export class ConversationStore {
  readonly #paths: PrefaixPaths;
  readonly #log:
    ((message: string, fields?: Record<string, unknown>) => void) | undefined;

  constructor(options: StoreOptions) {
    this.#paths = options.paths;
    this.#log = options.log;
  }

  get paths(): PrefaixPaths {
    return this.#paths;
  }

  async #ensureDir(): Promise<void> {
    await mkdir(this.#paths.conversationsDir, { recursive: true, mode: 0o700 });
  }

  async save(record: ConversationRecord): Promise<ConversationRecord> {
    await this.#ensureDir();
    const target = conversationFile(this.#paths, record.id);
    const temp = `${target}.${String(process.pid)}.tmp`;
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      // The data has to be on the medium before the rename, or a crash can
      // leave the name pointing at nothing.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
    return record;
  }

  async get(id: string): Promise<ConversationRecord | undefined> {
    let text: string;
    try {
      text = await readFile(conversationFile(this.#paths, id), "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw cause;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.#quarantine(id, "it is not valid JSON");
    }
    if (!isRecord(parsed)) {
      return this.#quarantine(id, "it is missing required fields");
    }
    return parsed;
  }

  async #quarantine(id: string, why: string): Promise<undefined> {
    // Moved rather than deleted: a hand-edited or half-written record is the
    // user's conversation history, and losing it silently is worse than a
    // file in a folder they can look at.
    const dir = posix.join(this.#paths.conversationsDir, ".corrupt");
    const from = conversationFile(this.#paths, id);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await rename(from, posix.join(dir, `${id}.json`));
    } catch (cause) {
      this.#log?.("could not quarantine a corrupt conversation file", {
        id,
        cause: messageOf(cause),
      });
    }
    this.#log?.("conversation file was corrupt", { id, why });
    return undefined;
  }

  /** Newest first, which is the order `:c` and `conversations ls` show. */
  async list(): Promise<ConversationRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#paths.conversationsDir);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw cause;
    }
    const records: ConversationRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) {
        continue;
      }
      const record = await this.get(name.slice(0, -".json".length));
      if (record !== undefined) {
        records.push(record);
      }
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async search(query: string, limit: number): Promise<ConversationRecord[]> {
    const needle = query.trim().toLowerCase();
    const all = await this.list();
    const matched =
      needle === ""
        ? all
        : all.filter(
            (record) =>
              record.title.toLowerCase().includes(needle) ||
              record.root.toLowerCase().includes(needle),
          );
    return matched.slice(0, Math.max(1, limit));
  }

  /** The most recent conversation for a root, for `workspace.resume`. */
  async lastInRoot(root: string): Promise<ConversationRecord | undefined> {
    return (await this.list()).find((record) => record.root === root);
  }

  async remove(id: string): Promise<boolean> {
    try {
      await unlink(conversationFile(this.#paths, id));
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw cause;
    }
  }

  async update(
    id: string,
    patch: Partial<Omit<ConversationRecord, "id" | "createdAt">>,
  ): Promise<ConversationRecord> {
    const existing = await this.get(id);
    if (existing === undefined) {
      throw new PrefaixError(
        "CONVERSATION_NOT_FOUND",
        `no conversation with id ${JSON.stringify(id)}`,
      );
    }
    return this.save({
      ...existing,
      ...patch,
      native: patch.native ?? existing.native,
      stats: patch.stats ?? existing.stats,
      createdBy: patch.createdBy ?? existing.createdBy,
      updatedAt: new Date().toISOString(),
    });
  }
}

export function summarize(record: ConversationRecord): {
  id: string;
  title: string;
  root: string;
  backend: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  costUsd?: number;
  lastContextPct?: number;
  model?: { provider: string; id: string };
  thinking?: string;
  persona?: string;
  createdBy: { shell: ShellKind; host: string };
} {
  return {
    id: record.id,
    title: record.title,
    root: record.root,
    backend: record.backend,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    turns: record.stats.turns,
    ...(record.stats.costUsd === undefined
      ? {}
      : { costUsd: record.stats.costUsd }),
    ...(record.stats.lastContextPct === undefined
      ? {}
      : { lastContextPct: record.stats.lastContextPct }),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.thinking === undefined ? {} : { thinking: record.thinking }),
    ...(record.persona === undefined ? {} : { persona: record.persona }),
    createdBy: record.createdBy,
  };
}
