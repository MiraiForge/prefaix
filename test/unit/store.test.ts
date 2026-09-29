import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConversationStore,
  newRecord,
  summarize,
  titleFrom,
} from "../../src/daemon/store.js";
import { conversationFile, resolvePaths } from "../../src/core/paths.js";
import { PrefaixError } from "../../src/core/errors.js";

/** A valid conversation id, since the store refuses to put anything else on disk. */
function cid(n: number): string {
  return `c_0${String(n).padStart(25, "0")}`;
}

let home = "";
let paths: ReturnType<typeof resolvePaths>;
let store: ConversationStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-store-"));
  paths = resolvePaths({ env: { HOME: home }, home });
  store = new ConversationStore({ paths });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function record(id = cid(0), prompt = "why does auth fail?") {
  return newRecord({
    id,
    backend: "pi",
    root: "/Users/tester/proj",
    prompt,
    shell: "zsh",
    host: "testbox",
  });
}

describe("a conversation's title", () => {
  it("is the first line of the first prompt, without the colon", () => {
    expect(titleFrom(": why does auth fail?\nand more")).toBe(
      "why does auth fail?",
    );
  });

  it("is the whole prompt when it is only one line", () => {
    expect(titleFrom(": why does auth fail?")).toBe("why does auth fail?");
  });

  it("collapses whitespace so the list column stays readable", () => {
    expect(titleFrom(": fix   the\ttest")).toBe("fix the test");
  });

  it("truncates a long prompt with an ellipsis", () => {
    const title = titleFrom(`: ${"x".repeat(200)}`);
    expect(title).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to a placeholder when there is no prompt", () => {
    expect(newRecord({ backend: "pi", root: "/r", shell: "bash" }).title).toBe(
      "new conversation",
    );
  });

  it("keeps a title the caller supplied", () => {
    expect(
      newRecord({ backend: "pi", root: "/r", shell: "bash", title: "chosen" })
        .title,
    ).toBe("chosen");
  });
});

describe("saving and loading", () => {
  it("writes a record the store can read back unchanged", async () => {
    const original = record();
    await store.save(original);
    expect(await store.get(original.id)).toEqual(original);
  });

  it("writes 0600, because the record carries the cwd and the shell", async () => {
    const saved = await store.save(record());
    const info = await stat(conversationFile(paths, saved.id));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind", async () => {
    await store.save(record());
    expect(readdirSync(paths.conversationsDir)).toEqual([`${cid(0)}.json`]);
  });

  it("reports a conversation that was never saved", async () => {
    expect(await store.get(cid(0))).toBeUndefined();
  });
});

describe("listing and searching", () => {
  it("returns newest first", async () => {
    await store.save(
      newRecord({
        id: cid(0),
        backend: "pi",
        root: "/a",
        shell: "zsh",
        now: () => new Date("2026-01-01T00:00:00Z"),
      }),
    );
    await store.save(
      newRecord({
        id: cid(1),
        backend: "pi",
        root: "/a",
        shell: "zsh",
        now: () => new Date("2026-02-01T00:00:00Z"),
      }),
    );
    expect((await store.list()).map((each) => each.id)).toEqual([
      cid(1),
      cid(0),
    ]);
  });

  it("returns nothing before anything has been saved", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("searches the title and the root, case-insensitively", async () => {
    await store.save(record(cid(0), "auth failure"));
    await store.save(
      newRecord({
        id: cid(1),
        backend: "pi",
        root: "/Users/tester/docs",
        shell: "zsh",
        prompt: "unrelated",
      }),
    );
    expect((await store.search("AUTH", 10)).map((r) => r.id)).toEqual([cid(0)]);
    expect((await store.search("docs", 10)).map((r) => r.id)).toEqual([cid(1)]);
    expect(await store.search("nothing", 10)).toEqual([]);
  });

  it("always returns at least one match, however small the limit", async () => {
    await store.save(record());
    expect(await store.search("", 0)).toHaveLength(1);
  });

  it("finds the most recent conversation for a root", async () => {
    await store.save(
      newRecord({
        id: cid(0),
        backend: "pi",
        root: "/a",
        shell: "zsh",
        now: () => new Date("2026-01-01T00:00:00Z"),
      }),
    );
    await store.save(
      newRecord({
        id: cid(1),
        backend: "pi",
        root: "/a",
        shell: "zsh",
        now: () => new Date("2026-02-01T00:00:00Z"),
      }),
    );
    await store.save(
      newRecord({ id: cid(2), backend: "pi", root: "/b", shell: "zsh" }),
    );
    expect((await store.lastInRoot("/a"))?.id).toBe(cid(1));
    expect(await store.lastInRoot("/nowhere")).toBeUndefined();
  });

  it("skips files that are not conversation records", async () => {
    await store.save(record());
    writeFileSync(join(paths.conversationsDir, "notes.txt"), "hi");
    writeFileSync(join(paths.conversationsDir, ".hidden.json"), "{}");
    expect(await store.list()).toHaveLength(1);
  });
});

describe("updating", () => {
  it("merges a patch and stamps updatedAt", async () => {
    const saved = await store.save(record());
    const updated = await store.update(saved.id, { title: "renamed" });
    expect(updated.title).toBe("renamed");
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(saved.updatedAt),
    );
  });

  it("keeps the native handle and the counters when the patch omits them", async () => {
    const saved = await store.save(record());
    await store.update(saved.id, {
      native: { sessionId: "pfx-1" },
      stats: { turns: 3, costUsd: 0.5 },
      createdBy: { shell: "fish", host: "testbox" },
    });
    const updated = await store.update(saved.id, { title: "later" });
    expect(updated.native).toEqual({ sessionId: "pfx-1" });
    expect(updated.stats).toEqual({ turns: 3, costUsd: 0.5 });
    expect(updated.createdBy).toEqual({ shell: "fish", host: "testbox" });
  });

  it("refuses to update a conversation that does not exist", async () => {
    await expect(store.update(cid(0), { title: "x" })).rejects.toBeInstanceOf(
      PrefaixError,
    );
  });

  it("removes a conversation and says so when it was already gone", async () => {
    const saved = await store.save(record());
    expect(await store.remove(saved.id)).toBe(true);
    expect(await store.remove(saved.id)).toBe(false);
  });
});

describe("a corrupt record", () => {
  it("is quarantined rather than deleted, and reported as missing", async () => {
    const saved = await store.save(record());
    writeFileSync(conversationFile(paths, saved.id), "{ not json");
    expect(await store.get(saved.id)).toBeUndefined();
    // The user's history is moved, not destroyed, so it can still be recovered
    // by hand from conversations/.corrupt/.
    expect(readdirSync(join(paths.conversationsDir, ".corrupt"))).toEqual([
      `${saved.id}.json`,
    ]);
  });

  it("is quarantined when the file is not a record at all", async () => {
    const saved = await store.save(record());
    // `null` parses and is not an object with the fields a record has, so it
    // takes the same path as broken json.
    writeFileSync(conversationFile(paths, saved.id), "null");
    expect(await store.get(saved.id)).toBeUndefined();
    writeFileSync(conversationFile(paths, saved.id), '["not", "a", "record"]');
    expect(await store.get(saved.id)).toBeUndefined();
    // Both went to the same place, so the second replaced the first.
    expect(readdirSync(join(paths.conversationsDir, ".corrupt"))).toHaveLength(
      1,
    );
  });

  it("is quarantined when it is missing required fields", async () => {
    const saved = await store.save(record());
    writeFileSync(conversationFile(paths, saved.id), '{"id":"c_x"}');
    expect(await store.get(saved.id)).toBeUndefined();
    expect(readdirSync(join(paths.conversationsDir, ".corrupt"))).toHaveLength(
      1,
    );
  });

  it("reports a quarantine it could not perform instead of throwing", async () => {
    const problems: string[] = [];
    const noisy = new ConversationStore({
      paths,
      log: (message) => problems.push(message),
    });
    const saved = await noisy.save(record());
    // Replace the record's directory with something that cannot be renamed
    // into, by making the target itself a directory.
    rmSync(conversationFile(paths, saved.id));
    writeFileSync(conversationFile(paths, saved.id), "{ not json");
    // A directory already sitting where the quarantine would land makes the
    // rename fail, which is the case that must be reported and not thrown.
    mkdirSync(join(paths.conversationsDir, ".corrupt", `${saved.id}.json`), {
      recursive: true,
    });
    expect(await noisy.get(saved.id)).toBeUndefined();
    expect(problems.some((line) => line.includes("could not quarantine"))).toBe(
      true,
    );
  });
});

describe("the wire summary", () => {
  it("carries what a list row shows and omits what is unset", () => {
    const summary = summarize({
      ...record(),
      model: { provider: "pi", id: "flash" },
      thinking: "medium",
      persona: "ask",
      stats: { turns: 2, costUsd: 0.02, lastContextPct: 12 },
    });
    expect(summary).toMatchObject({
      id: cid(0),
      title: "why does auth fail?",
      backend: "pi",
      turns: 2,
      costUsd: 0.02,
      lastContextPct: 12,
      model: { provider: "pi", id: "flash" },
      thinking: "medium",
      persona: "ask",
      createdBy: { shell: "zsh", host: "testbox" },
    });
  });

  it("leaves out the optional fields a fresh conversation does not have", () => {
    const summary = summarize(record());
    expect("costUsd" in summary).toBe(false);
    expect("model" in summary).toBe(false);
    expect(summary.turns).toBe(0);
  });
});
