// The opt-in live gate (DESIGN §12.4, and the "To finish" section of
// docs/spikes/S9-pi-bridge-extension.md).
//
// This is the only test in the repository that sends a model request, and it
// does not send one unless a human has named an allowed provider and model in
// the environment. With those unset the whole file skips, which is the state
// every development run and every CI run is in.
//
// What it asserts is the part of the S9 acceptance that a fixture cannot reach:
// `before_agent_start` fires inside pi's agent loop, so the transcript's system
// message, the tool set the model was offered, and the untouched user message
// are only observable against a real pi. The bridge writes what it saw to
// `<turns>/<pid>.applied.log`, and that log is the artifact asserted on, rather
// than anything inferred from stdout.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertLiveAllowed,
  LIVE_ENV,
  type LiveRequest,
} from "../../scripts/live-guard.js";
import {
  createPiAdapter,
  type PiSession,
} from "../../src/agents/pi/adapter.js";
import { defaultConfig } from "../../src/core/config/schema.js";
import { turnContextFile } from "../../src/agents/pi/bridge-context.js";
import type { ShellContext } from "../../src/core/agent-port.js";
import type { AgentEvent } from "../../src/core/agent-port.js";

/**
 * Whether a human has authorised a model request. The guard is the authority on
 * which provider and model, so it is asked first and its refusal is the reason
 * this file skips.
 */
function liveOrSkip(): LiveRequest | undefined {
  try {
    return assertLiveAllowed();
  } catch (cause) {
    console.log(
      `  live: skipped — ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return undefined;
  }
}

const live = liveOrSkip();

const CONTEXT: ShellContext = {
  shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
  cwd: process.cwd(),
  recent: [{ cmd: "git status", exit: 0 }],
  os: `${process.platform} ${process.arch}`,
  term: { cols: 100, rows: 30, colors: 256 },
};

interface AppliedRecord {
  readonly prompt: string;
  readonly section: boolean;
  readonly persona?: string;
}

let dir = "";
let session: PiSession | undefined;
const events: AgentEvent[] = [];

beforeAll(async () => {
  if (live === undefined) {
    return;
  }
  dir = mkdtempSync(join(tmpdir(), "pfx-live-"));
  const config = defaultConfig();
  const adapter = createPiAdapter({
    bin: config.agent.pi.bin,
    // The slug carries the vendor, so `--model` names the provider too. pi's
    // configured default is never relied on, which is the same rule the guard
    // enforces.
    model: live.model,
    turnsDir: dir,
    bridgePath: bridgeBundlePath(),
    log: (message, fields) => {
      console.log(`  live pi: ${message} ${JSON.stringify(fields ?? {})}`);
    },
  });
  session = (await adapter.open({
    root: process.cwd(),
    // pi's own environment, minus the undefined entries `process.env` is
    // allowed to have and a child is not.
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (pair): pair is [string, string] => pair[1] !== undefined,
      ),
    ),
  })) as PiSession;
  for await (const event of session.prompt(
    { text: ": say hello", context: CONTEXT },
    new AbortController().signal,
  )) {
    events.push(event);
  }
}, 180_000);

afterAll(async () => {
  await session?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The bundle the build produces, which is what `-e` loads. */
function bridgeBundlePath(): string {
  return join(process.cwd(), "dist/pi-bridge.js");
}

describe.skipIf(live === undefined)("a real pi with the bridge loaded", () => {
  it("announces itself, so the adapter knows the section path is live", () => {
    expect(session?.pid).toBeTypeOf("number");
    // A missing ready file would mean the prepend fallback ran instead, and
    // every assertion below would be about the wrong code path.
    expect(session?.bridgeLive).toBe(true);
  });

  it("patches the prefaix section without touching the user's message", () => {
    const applied = appliedRecords();
    expect(applied.length).toBeGreaterThan(0);
    const last = applied.at(-1);
    // The section was patched, not prepended: that is the whole point of the
    // extension, and the log says which path ran.
    expect(last?.section).toBe(true);
    // The user message is the one the client sent and not one the bridge
    // rewrote.
    expect(last?.prompt).toBe(": say hello");
  });

  it("leaves no context file behind, because the extension removed it", () => {
    const pid = session?.pid ?? 0;
    // The file is created before the turn and deleted by the extension once it
    // has read it; a file still here means the bridge never loaded.
    expect(() => readFileSync(turnContextFile(dir, pid))).toThrow();
  });

  it("settles with a real answer", () => {
    const settled = events.find((event) => event.type === "settled");
    expect(settled).toBeDefined();
    if (settled?.type === "settled") {
      expect(settled.stopReason).toBe("stop");
    }
    // A real turn produced text; an empty stream would mean the fixtures were
    // replayed instead of a model being asked.
    expect(
      events.some((event) => event.type === "text_delta" && event.text !== ""),
    ).toBe(true);
  });
});

function appliedRecords(): AppliedRecord[] {
  const pid = session?.pid ?? 0;
  const file = join(dir, `${String(pid)}.applied.log`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as AppliedRecord);
}

// The environment names the gate, so a CI log that skipped it says which
// variables were missing rather than leaving a bare "skipped".
if (live === undefined) {
  console.log(
    `  live: set ${LIVE_ENV.provider} and ${LIVE_ENV.model} to run the real-pi gate`,
  );
}
