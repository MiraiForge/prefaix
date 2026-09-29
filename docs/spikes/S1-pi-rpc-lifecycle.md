# Spike S1 — pi RPC lifecycle

**Status: partially verified.** Everything reachable without sending a model
request is recorded below and re-runnable with `scripts/spikes/rpc-probe.mts`.
The questions that need a live turn are listed at the end and are blocked on an
allowed provider, not on effort.

- pi 0.87.1, macOS, Node 26, spawned as `pi --mode rpc --offline`
- Verified by running it, on 2026-09-28
- Protocol facts come from pi's own type definitions, which are the source of
  truth for the mapping in DESIGN §4.5.3

## Where the types live

pi ships no `rpc-types` import path from the CLI install; the declarations are
inside the managed release, readable without a dependency:

| What | Path under `…/install/releases/0.87.1/node_modules/` |
|---|---|
| Commands, responses, `extension_ui_request` | `@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts` |
| The wire event union | `@earendil-works/pi-coding-agent/dist/modes/json-event.d.ts` + `dist/core/agent-session.d.ts` |
| `AgentEvent`, `AssistantMessageEvent` | `@earendil-works/pi-agent-core/dist/types.d.ts`, `@earendil-works/pi-ai/dist/types.d.ts` |

M2-4/M2-5 should vendor a minimal typed subset from these rather than add a
runtime dependency, as DESIGN §4.5.2 already allows.

## The wire format, verified

The protocol is **not** JSON-RPC 2.0. A request is `{"id","type",…}` and the
command name lives in `type`; a reply is
`{"id","type":"response","command","success","data" | "error"}`.

Sending `{"jsonrpc":"2.0","id","method":"get_state"}` yields
`Unknown command: undefined`, which is the cheap way to notice.

| Observation | Detail |
|---|---|
| Framing | LF only, one JSON object per line, no CR seen. Splitting on `\n` is enough. |
| Readiness | First successful `get_state` response. `session_info_changed` was observed 26 ms after it. |
| Events carry no `id` | `session_info_changed`, `queue_update`, `thinking_level_changed` arrive unsolicited. Any id-less record is an event, never a reply to correlate. |
| Errors are flat strings | `{"success":false,"error":"Unknown command: x"}`. No code, so the adapter has to classify the text into an `ErrorCode` itself. |
| pi leaks internal errors | `set_session_name` with no `name` returns `Cannot read properties of undefined (reading 'trim')`. Never surface a raw pi error to the user. |
| Missing validation | `set_thinking_level` with no `level` **succeeds** and resets to `off`. |
| `get_last_assistant_text` when idle | Returns `data: {}`, though the type declares `{text: string \| null}`. The adapter must map `{}` to `null`. |
| `get_state` keys | `autoCompactionEnabled followUpMode isCompacting isStreaming messageCount model pendingMessageCount sessionFile sessionId steeringMode thinkingLevel` |
| `get_session_stats` | Carries `sessionFile`, the absolute path to resume with `--session`. |
| Default model | `openai-codex/gpt-6-sol`, even with `--offline`. Confirms DESIGN §12.4: pi's configured default must never be relied on. |
| `--session-id pfx-<ULID>` | Accepted, creates when missing, no prompt. Verified three times back to back with a custom id. |
| stdin close | Exit code **0**, prompt and immediate. This is the graceful shutdown. |
| SIGTERM | Exit code **143**, not 0. The escalation must accept a signal code. |
| SIGKILL | No exit code, only `signal: "SIGKILL"`. Nothing is written, so the transport must synthesize the failure itself. |

### Startup can block, and says nothing when it does

Four of roughly twenty spawns produced **no stdout and no stderr at all** and
never became ready. All four fell inside a window in which pi rewrote
`~/.pi/agent/models-store.json`; eleven consecutive spawns after that were fine.
The same flags worked and failed across runs, so it is not flag-dependent.

The consequence is concrete: `ready` is a wait with a deadline, never a
certainty, and M2-4's spawn path needs a startup timeout plus a respawn. A
spinner that waits forever is the failure mode to avoid.

`--offline` made no measurable difference to the no-model path: 192 ms ready
with it, 232 ms without. S2 still has to measure it with extensions and a real
turn.

## What pi's types say about the turn

The event union, for M2-5's mapping table:

```text
agent_start
agent_end            { messages, willRetry }
agent_settled
turn_start | turn_end { message, toolResults }
message_start        { message }
message_update       { usage, assistantMessageEvent }   # cumulative usage, every delta
message_end          { message }
tool_execution_start { toolCallId, toolName, args }
tool_execution_update{ toolCallId, toolName, args, partialResult }
tool_execution_end   { toolCallId, toolName, result, isError }
compaction_start     { reason: manual|threshold|overflow }
compaction_end       { reason, result, aborted, willRetry, errorMessage? }
auto_retry_start     { attempt, maxAttempts, delayMs, errorMessage }
auto_retry_end       { success, attempt, finalError? }
queue_update | entry_appended | session_info_changed | thinking_level_changed
bash_execution_update | summarization_retry_*
```

`assistantMessageEvent` nests the text events, so a `text_delta` is a field of a
`message_update`, never a top-level record:

```text
start | done{reason} | error
text_start  { contentIndex }
text_delta  { contentIndex, delta }
text_end    { contentIndex, content }
thinking_start | thinking_delta | thinking_end
toolcall_start | toolcall_delta{contentIndex,delta} | toolcall_end{contentIndex,toolCall}
```

`extension_ui_request` carries an `id` and one of
`select | confirm | input | editor | notify | setStatus | setWidget | setTitle | set_editor_text`;
the reply is `extension_ui_response` with `value`, `confirmed`, or `cancelled`.

### Corrections DESIGN §4.5.3 needs

The design is right about most of the mapping. Four details differ:

| DESIGN says | pi actually has |
|---|---|
| `retry` with `max` and `reason` | `auto_retry_start` carries `maxAttempts` and `errorMessage` |
| `compaction` end with `ok` | `compaction_end` has `aborted` and `willRetry`; `ok` is derived |
| `message_update.usage`, `message_end` → usage | `usage` is on **every** `message_update`, cumulative |
| `toolcall_start` buffered until `tool_execution_start` | confirmed: `args` are complete at `tool_execution_start`, and the ids are `toolCallId` |

One documented subtlety answers part of the S1 question: pi's own comments say
`agent_end` is the last event of a run, but settlement waits for its `subscribe`
listeners and *the agent is idle only after those listeners finish*. That is
strong evidence `agent_settled` is the marker to trust, and not proof — the
proof needs a live abort.

## Not verified, and why

These need a turn, which needs an allowed provider. `PREFAIX_LIVE_PROVIDER` and
`PREFAIX_LIVE_MODEL` are not set, and DESIGN §12.4 plus `AGENTS.md` forbid
sending anything without them.

- `prompt` → stream → `agent_settled`, and the exact interleave of `agent_start`,
  `turn_start`, `message_start`, deltas, `message_end`
- abort **mid-text** and **mid-tool**: does `abort` always end in
  `agent_settled`, and is the terminal `stopReason` recoverable?
- retry ordering: `auto_retry_start` / `auto_retry_end` against
  `agent_end { willRetry: true }`, and which of the two means "still working"
- compaction ordering: `compaction_start` / `compaction_end` inside a turn
- a second turn on the same session, and `--session` resume from another cwd (S3)
- `kill -9` **mid-turn**
- the S1 fixture recordings themselves

To finish the spike, export a provider the guard allows and re-run:

```sh
export PREFAIX_LIVE_PROVIDER=google
export PREFAIX_LIVE_MODEL=google/<an-allowed-model>
```

`scripts/live-guard.ts` is written and unit-tested: it requires both variables,
refuses `anthropic*`, `openai*`, `openai-codex*` and `anthropic/*` or `openai/*`
slugs behind a router, refuses a model with no vendor prefix, and returns the
`--provider`/`--model` argv so no call can fall back to pi's default.

The probe script for the live half is the obvious next step: a
`scripts/spikes/rpc-live.mts` that asserts `assertLiveAllowed()` first, streams
one prompt, aborts mid-tool, and records the raw JSONL into
`test/fixtures/pi/`. It should be written so that a refusal exits non-zero
before pi is ever spawned.
