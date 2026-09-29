// A stand-in for the pi child: it speaks the same JSONL protocol, replays a
// recorded fixture, and records every command it was sent to a trace file, so a
// test can assert on what prefaix asked for.
//
//   node test/fixtures/pi/child.mjs <fixture.jsonl> [--hang]
//   PREFAIX_CHILD_TRACE=/tmp/commands.jsonl node …/child.mjs <fixture>
//
// Fixture format: one JSON record per line, exactly as pi writes it, plus three
// keys the child interprets and never emits:
//
//   delay         ms to wait before writing the record
//   waitForUi     hold here until an extension_ui_response for `uiId` arrives
//   untilCommand  hold here until a command of that type is received
//
// `{{id}}` in a record is replaced with the id of the command being answered, so
// one fixture serves every request id. The holds are what let a dialog or an
// abort fixture express real causality instead of a blind linear dump.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [, , fixturePath, ...flags] = process.argv;
const hang = flags.includes("--hang");
const tracePath = process.env["PREFAIX_CHILD_TRACE"];

const fixture =
  fixturePath === undefined
    ? []
    : readFileSync(fixturePath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));

if (fixturePath === undefined) {
  process.stderr.write("child.mjs needs a fixture path\n");
  process.exit(2);
}

const seen = [];
let buffer = "";
let lastId = null;
let closed = false;
// A real pi stops producing when it is aborted mid-turn.
let aborted = false;

if (tracePath !== undefined) {
  writeFileSync(tracePath, "");
}

function trace(command) {
  if (tracePath === undefined) {
    return;
  }
  appendFileSync(tracePath, `${JSON.stringify(command)}\n`);
}

function write(text) {
  if (!closed) {
    process.stdout.write(text);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolvers waiting on a command type or a ui response, keyed by what they await. */
const waiters = { command: new Map(), ui: new Map() };

function awaitCommand(type) {
  return new Promise((resolve) => {
    if (seen.some((command) => command.type === type)) {
      resolve(undefined);
      return;
    }
    waiters.command.set(type, resolve);
  });
}

function awaitUi(uiId) {
  return new Promise((resolve) => {
    if (
      seen.some(
        (command) =>
          command.type === "extension_ui_response" && command.id === uiId,
      )
    ) {
      resolve(undefined);
      return;
    }
    waiters.ui.set(uiId, resolve);
  });
}

async function play() {
  state.isStreaming = true;
  for (const record of fixture) {
    if (record["waitForUi"] !== undefined) {
      await awaitUi(record["waitForUi"]);
    }
    if (record["untilCommand"] !== undefined) {
      await awaitCommand(record["untilCommand"]);
    }
    if (record["delay"] !== undefined) {
      await sleep(record["delay"]);
    }
    if (closed || aborted) {
      state.isStreaming = false;
      return;
    }
    // Strip the keys the child interprets for itself and never emits.
    const rest = { ...record };
    delete rest.delay;
    delete rest.waitForUi;
    delete rest.untilCommand;
    delete rest.eager;
    if (rest.type === "message_end") {
      const message = rest.message;
      if (message !== null && typeof message === "object") {
        const text = message.content;
        if (Array.isArray(text)) {
          const joined = text
            .filter(
              (part) =>
                part !== null &&
                typeof part === "object" &&
                part.type === "text",
            )
            .map((part) => part.text)
            .join("");
          if (joined !== "") {
            state.lastAssistantText = joined;
          }
        }
      }
    }
    if (rest.type === "agent_settled") {
      state.isStreaming = false;
    }
    // A record that only holds a hold-point has nothing to emit.
    if (rest.type === undefined) {
      continue;
    }
    const id = rest.id === "{{id}}" ? lastId : rest.id;
    const rendered = JSON.stringify(id === undefined ? rest : { ...rest, id });
    write(`${rendered.replaceAll("{{id}}", String(lastId))}\n`);
  }
  // A real pi child keeps running between turns; the parent's stdin close ends
  // it, which is also what the shutdown escalation is tested against.
  state.isStreaming = false;
}

const state = {
  sessionId: "01a0ea38-719b-778d-9f81-e9cf3570db2c",
  sessionName: undefined,
  thinkingLevel: "off",
  isStreaming: false,
  lastAssistantText: null,
  queue: [],
  model: { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai-codex" },
};

function ok(id, command, data) {
  const record = { id, type: "response", command, success: true };
  write(
    `${JSON.stringify(data === undefined ? record : { ...record, data })}\n`,
  );
}

function fail(id, command, error) {
  write(
    `${JSON.stringify({ id, type: "response", command, success: false, error })}\n`,
  );
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim() === "") {
      continue;
    }
    const command = JSON.parse(line);
    seen.push(command);
    trace(command);
    lastId = command.id ?? null;
    for (const [type, resolve] of waiters.command) {
      if (type === command.type) {
        waiters.command.delete(type);
        resolve(undefined);
      }
    }
    if (command.type === "extension_ui_response") {
      const resolve = waiters.ui.get(command.id);
      if (resolve !== undefined) {
        waiters.ui.delete(command.id);
        resolve(undefined);
      }
    }

    const id = command.id;
    switch (command.type) {
      case "get_state": {
        // An "eager" record is written before the reply, which is how a
        // recording of leftovers from an abandoned turn is expressed.
        for (const record of fixture) {
          if (record.eager === true) {
            const emitted = { ...record };
            delete emitted.eager;
            write(`${JSON.stringify(emitted)}\n`);
          }
        }
        ok(id, "get_state", {
          sessionId: state.sessionId,
          sessionFile: `/pi/sessions/${state.sessionId}.jsonl`,
          ...(state.sessionName === undefined
            ? {}
            : { sessionName: state.sessionName }),
          model: state.model,
          thinkingLevel: state.thinkingLevel,
          isStreaming: state.isStreaming,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "all",
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        });
        break;
      }
      case "get_available_models": {
        ok(id, "get_available_models", {
          models: [
            {
              id: "gemini-3.8-flash",
              name: "Gemini 3.8 Flash",
              provider: "google",
              contextWindow: 1000000,
              reasoning: true,
            },
            {
              id: "gpt-6-sol",
              name: "GPT-6 Sol",
              provider: "openai-codex",
              contextWindow: 400000,
              reasoning: true,
            },
          ],
        });
        break;
      }
      case "get_available_thinking_levels": {
        ok(id, "get_available_thinking_levels", {
          levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        });
        break;
      }
      case "get_commands": {
        ok(id, "get_commands", {
          commands: [
            { name: "review", description: "Review the diff", source: "skill" },
            {
              name: "explain",
              description: "Explain a file",
              source: "prompt",
            },
            {
              name: "lens",
              description: "Inspect the UI",
              source: "extension",
            },
          ],
        });
        break;
      }
      case "get_last_assistant_text": {
        // pi sends {} when there is no completed turn.
        ok(
          id,
          "get_last_assistant_text",
          state.lastAssistantText === null
            ? {}
            : { text: state.lastAssistantText },
        );
        break;
      }
      case "get_session_stats": {
        ok(id, "get_session_stats", {
          sessionId: state.sessionId,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, total: 0 },
          cost: 0,
        });
        break;
      }
      case "set_thinking_level": {
        state.thinkingLevel = command.level ?? "off";
        write(
          `${JSON.stringify({ type: "thinking_level_changed", level: state.thinkingLevel })}\n`,
        );
        ok(id, "set_thinking_level", undefined);
        break;
      }
      case "set_session_name": {
        if (typeof command.name !== "string") {
          // pi leaks its own TypeError for this shape; the child does too, so
          // the adapter's handling of it is exercised.
          fail(
            id,
            "set_session_name",
            "Cannot read properties of undefined (reading 'trim')",
          );
          break;
        }
        state.sessionName = command.name;
        write(
          `${JSON.stringify({ type: "session_info_changed", name: command.name })}\n`,
        );
        ok(id, "set_session_name", undefined);
        break;
      }
      case "set_model": {
        const known = [
          { provider: "google", id: "gemini-3.8-flash" },
          { provider: "openai-codex", id: "gpt-6-sol" },
        ];
        const isKnown = known.some(
          (model) =>
            model.provider === command.provider && model.id === command.modelId,
        );
        if (
          typeof command.provider !== "string" ||
          typeof command.modelId !== "string" ||
          !isKnown
        ) {
          fail(
            id,
            "set_model",
            `Model not found: ${String(command.provider)}/${String(command.modelId)}`,
          );
          break;
        }
        state.model = { provider: command.provider, id: command.modelId };
        ok(id, "set_model", state.model);
        break;
      }
      case "steer":
      case "follow_up": {
        // M4 queueing: the text is held until it is cleared by an abort.
        state.queue.push(command.message);
        ok(id, command.type, undefined);
        break;
      }
      case "set_steering_mode":
      case "set_follow_up_mode":
      case "set_auto_compaction":
      case "set_auto_retry": {
        ok(id, command.type, undefined);
        break;
      }
      case "abort": {
        aborted = true;
        state.isStreaming = false;
        ok(id, "abort", undefined);
        break;
      }
      case "clear_queue": {
        const steering = state.queue.splice(0, state.queue.length);
        write(
          `${JSON.stringify({ type: "queue_update", steering, followUp: [] })}\n`,
        );
        ok(id, "clear_queue", { steering, followUp: [] });
        break;
      }
      case "compact": {
        ok(id, "compact", { summary: "fixture summary", tokensBefore: 1000 });
        break;
      }
      case "get_fork_messages": {
        ok(id, "get_fork_messages", { messages: [] });
        break;
      }
      case "prompt": {
        ok(id, "prompt", undefined);
        void play();
        break;
      }
      case "no_such_command": {
        fail(id, "no_such_command", "Unknown command: no_such_command");
        break;
      }
      default: {
        fail(id, command.type, `Unknown command: ${String(command.type)}`);
        break;
      }
    }
  }
});

process.stdin.on("end", () => {
  if (hang) {
    return;
  }
  closed = true;
  process.exit(0);
});

process.on("SIGTERM", () => {
  closed = true;
  process.exit(143);
});
