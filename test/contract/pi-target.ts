// The contract suite's target for PiAdapter with fixture replay (DESIGN §12.2):
// a real PiAdapter driving the real JSONL transport, against a child that
// replays a recording and traces the commands it received.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPiAdapter,
  type PiSession,
} from "../../src/agents/pi/adapter.js";
import type {
  AgentEvent,
  AgentSession,
  PromptInput,
  ShellContext,
} from "../../src/core/agent-port.js";
import type { ContractCase, ContractTarget, TurnRun } from "./suite.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHILD = join(ROOT, "test/fixtures/pi/child.mjs");
const FIXTURES = join(ROOT, "test/fixtures/pi");

const CONTEXT: ShellContext = {
  shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
  cwd: ROOT,
  recent: [{ cmd: "git pull", exit: 0 }],
  os: "test",
  term: { cols: 100, rows: 30, colors: 256 },
};

function promptInput(text: string): PromptInput {
  return { text, context: CONTEXT };
}

const SCRIPTS: Record<ContractCase, string> = {
  stream: "stream.jsonl",
  tools: "tools.jsonl",
  dialog: "dialog.jsonl",
  error: "error.jsonl",
  retry: "retry.jsonl",
  abortDuringTool: "abort.jsonl",
  abortFromSignal: "stream.jsonl",
  abortFromMethod: "stream.jsonl",
};

export interface PiTargetOptions {
  readonly hang?: boolean;
  readonly trace?: boolean;
}

/** Every command the child was sent, in order. */
export function traceCommands(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

class PiRun implements TurnRun {
  readonly events: AgentEvent[] = [];
  readonly #session: AgentSession;
  readonly #controller = new AbortController();
  readonly #watchers = new Set<(event: AgentEvent) => void>();
  readonly #run: Promise<void>;

  constructor(session: AgentSession) {
    this.#session = session;
    this.#run = (async () => {
      for await (const event of session.prompt(
        promptInput(": contract"),
        this.#controller.signal,
      )) {
        this.events.push(event);
        for (const watch of [...this.#watchers]) {
          watch(event);
        }
      }
    })();
  }

  get session(): AgentSession {
    return this.#session;
  }

  get done(): Promise<void> {
    return this.#run;
  }

  async until(
    match: (event: AgentEvent) => boolean,
    what = "the expected event",
  ): Promise<void> {
    if (this.events.some(match)) {
      return;
    }
    const found = new Promise<void>((resolve) => {
      const watch = (event: AgentEvent): void => {
        if (!match(event)) {
          return;
        }
        this.#watchers.delete(watch);
        resolve();
      };
      this.#watchers.add(watch);
    });
    await Promise.race([
      found,
      this.#run.then(() => {
        throw new Error(`the turn ended before ${what} arrived`);
      }),
    ]);
  }

  async stop(via: "signal" | "method" | "both" = "both"): Promise<void> {
    if (via !== "method") {
      this.#controller.abort();
    }
    if (via !== "signal") {
      await this.#session.abort();
    }
  }
}

export function piTarget(options: PiTargetOptions = {}): ContractTarget {
  const open = async (fixture: string): Promise<PiSession> => {
    const trace =
      options.trace === true
        ? join(mkdtempSync(join(tmpdir(), "pfx-pi-trace-")), "commands.jsonl")
        : undefined;
    const adapter = createPiAdapter({
      // The child is the fixture replayer, standing in for the pi binary.
      rpc: {
        bin: process.execPath,
        args: [
          CHILD,
          join(FIXTURES, fixture),
          ...(options.hang === true ? ["--hang"] : []),
        ],
        env: trace === undefined ? {} : { PREFAIX_CHILD_TRACE: trace },
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 4_000,
        termGraceMs: 300,
        killGraceMs: 300,
      },
    });
    return (await adapter.open({
      root: ROOT,
      env: {},
    })) as PiSession;
  };

  return {
    name: "pi (fixture replay)",
    capabilities: createPiAdapter().capabilities,
    probe: async () => ({ installed: true, usable: true, version: "fixture" }),
    // An idle session: open() already waited for readiness, so a turn that
    // starts here would find no fixture to play.
    open: () => open("stream.jsonl"),
    async start(caseName: ContractCase): Promise<TurnRun> {
      return new PiRun(await open(SCRIPTS[caseName]));
    },
  };
}
