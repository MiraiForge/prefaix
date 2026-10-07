# Spike S1 — pi RPC lifecycle

**Status: verified for pi 1.0.4; first replay fixtures implemented.**
On 2026-10-07, the user selected Kimi K3 through the coding plan. The guarded
live recorder passed all five prompted turns with `kimi-coding/k3`: streaming,
same-session continuation, mid-text and mid-tool abort, and mid-turn SIGKILL.
Six additional native pi cases verify retry and compaction ordering against an
explicitly **controlled, loopback-only API**, without credentials or remote
model requests. Ten reviewed replay fixtures retain their source labels and
raw-capture provenance. Synthetic child tests are not native or live evidence.

The original no-model observations below are re-runnable with
`scripts/spikes/rpc-probe.mts`. The recorder was implemented on 2026-10-06 without
sending a turn; the live selection was supplied explicitly for the later run.

Original measurements:

- pi 0.87.1, macOS, Node 26, spawned as `pi --mode rpc --offline`
- Verified by running it, on 2026-09-28
- Protocol facts come from pi's own type definitions, which are the source of
  truth for the mapping in DESIGN §4.5.3

## Question

Which native event lets the turn manager safely release a foreground turn across
streaming, retries, compaction, and cancellation? Does abort settle before its RPC
acknowledgment, can the same native session run a second turn, and what must the
transport synthesize when a child dies? Compare stdin-close shutdown with signal
termination and preserve replayable evidence for the adapter contract.

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
the original evidence for trusting `agent_settled`. The 2026-10-07 live run
now confirms that boundary for both abort cases tested below, but does not
establish retry or compaction ordering.

## Evidence boundary

The successful live Kimi run observed **zero retry and compaction events**.
Those questions are answered by the separate controlled native-pi measurements
below, not by relabeling synthetic tests or claiming a natural Kimi outage.
This verifies pi's lifecycle machinery under explicit API stimuli; it does not
measure real-provider rate limits, summary quality, or future pi versions.
Cross-directory `--session` resume belongs to S3; recorded extension UI belongs
to S9. Completing S1 does not by itself meet the whole M1 exit gate.

## Guarded recorder (2026-10-06)

`scripts/spikes/rpc-live.ts` is runnable through `bun run spike:rpc-live`. The
user-approved primary selection is Kimi K3 on the Kimi coding plan:

```sh
PREFAIX_LIVE_PROVIDER=kimi-coding \
PREFAIX_LIVE_MODEL=kimi-coding/k3 \
bun run spike:rpc-live --record build/spikes/S1-review
```

Pi uses `KIMI_API_KEY` or its existing configured credential. No key goes in the
selection variables or recorder arguments. Scope these variables to the command;
exporting them globally would also enable the opt-in live contract gate during
ordinary checks.

The user-approved alternative is `PREFAIX_LIVE_PROVIDER=zai` with
`PREFAIX_LIVE_MODEL=zai/glm-5.3-flash` and a configured `ZAI_API_KEY`. Pi 1.0.4's
catalog routes this provider to `https://api.z.ai/api/coding/paas/v4`, not the
regular pay-as-you-go endpoint. Z.AI authentication was not ready for the
initial live attempt, and 1Password secret reads timed out. After the user
approved CLI access later on 2026-10-07, both selected 1Password credential fields
were readable and populated. Injecting each key into an isolated temporary pi
profile made `pi auth check --json --no-refresh` report `ready` for its exact
provider/model. That verifies local credential resolution, not upstream validity;
no model request was sent during those checks. Keys were kept in process memory
and command-scoped environments, never printed or written to configuration.
No Z.AI model request has been sent.

`--record` must name a **new** directory; existing evidence is never overwritten.
With no argument, the directory is `build/spikes/S1-<timestamp>`. `--help` sends
no request. Ordinary `check`, coverage, and contract runs do not invoke this
command. A successful run sends **five prompts**, not five guaranteed provider
requests: pi may retry or compact automatically.

### Method and checks

| Capture | Method | Required observation |
|---|---|---|
| `stream` | Ask for a remembered code and greeting, then ask for that code without repeating it | Two successful text turns, one `agent_settled` each, unchanged native session ID/file, and the code in the second answer |
| `abort-text` | Request a long answer; wait for a nonempty text delta; send `clear_queue`, then `abort` | Text still unfinished when abort is sent; exactly one settle; pi idle afterward |
| `abort-tool` | Ask for the side-effect-free `prefaix_s1_wait` tool; wait for its execution update | The tool has actually started and has not ended when abort is sent; exactly one settle; pi idle afterward |
| `kill-text` | Request a long answer; send SIGKILL after a nonempty text delta | Text still unfinished; signal exit; no invented wire `agent_settled` |
| Shutdown | Close stdin after each child | Exit 0 without escalation for the three orderly shutdowns |

Each settled turn checks that `agent_end` precedes `agent_settled`, and rejects
duplicate settles or run events after settlement. Stop reasons are recorded
from raw assistant `message_end` records, not rewritten into an adapter result.
Synthetic tests include a tool abort with a final raw reason of `toolUse`.
The live pi 1.0.4 run instead produced `toolUse` followed by a zero-usage
assistant `error` with `This operation was aborted`. Neither shape should turn
an explicit user abort into a normalized error; see the live decision below.

The recorder uses the existing `PiRpc` request transport, with a recording child
wrapper. It keeps reading stdout continuously, splits only on LF, preserves
split UTF-8 and Unicode separators, and drains stdout/stderr before recording
process close. Startup, requests, trigger waits, settlement, and shutdown have
deadlines. Timeouts and interrupts close or kill the child, remove its temporary
workspace, retain partial captures, and write a failed summary. A fast turn that
already completed cannot pass as a mid-turn abort.

The guard runs **before filesystem work, the version probe, or any pi spawn**.
Before every prompt, the recorder also checks the selected provider and exact
model against `get_state`; fuzzy model patterns and thinking suffixes are not
accepted as exact IDs. Both `--provider` and `--model` are passed explicitly.
The shared guard now refuses vendor **prefixes**, including names such as
`anthropic-compatible` and `openai-codex-custom`, as DESIGN §12.4 requires.

All children use an empty temporary cwd, private session storage inside the
recording directory, and disable discovered extensions, skills, templates,
themes, context files, MCP, and project approval. Text-only children have no
tools. The tool-abort child loads only `scripts/spikes/rpc-wait-tool.ts` and
exposes only its wait tool: a cancellable 30-second delay with no shell, file,
network, or model side effects. Registration itself starts no timer.

### Artifacts and interpretation

The directory is mode 0700 and capture files are mode 0600. Review everything
before sharing it: raw output and pi transcripts may still contain sensitive
provider diagnostics or machine paths. The default `build/` location is ignored
by git. No curated `test/fixtures/pi/` file is overwritten automatically.

- `<scenario>.jsonl`: one `prefaix_fixture_header` with provider, model, pi
  version, timestamp, and `source: live`, followed by unmodified stdout.
- `<scenario>.trace.jsonl`: monotonic receive/send timestamps, raw stdin/stdout
  chunks, stderr chunks, stdin-close and signal actions, and the actual exit.
- `<scenario>.stderr.log`: stderr kept separate from protocol output.
- `summary.json`: pass/fail for these scenarios, failure details, native session
  references, event order, assistant stop reasons, and half-open, zero-based
  raw-record ranges for each turn. Ranges exclude the fixture header.
- `sessions/`: pi's native transcripts; the temporary working directory is
  removed, but this evidence is retained.

`source: synthetic` is mandatory whenever tests inject a child. The
`test/unit/rpc-live.test.ts` replays causal JSONL, including settlement before an
abort response, same-read acceptance/completion, missing settlement, provider
mismatch, retries, compaction, and crashes. It also checks guard refusal at the
actual CLI boundary. `test/unit/rpc-wait-tool.test.ts` checks registration,
completion, and cancellation without a model.

A `passed` live summary does **not** finish S1 by itself. Retry and compaction
counters only report events actually seen; zero is not evidence about ordering.
The live recorder does not fabricate provider failures or force an expensive
context overflow. S1 acceptance combines reviewed live captures, the separately
labeled native retry/compaction measurements, and replay fixtures derived from
both. Preserve each original raw capture as the curation reference. S3's
cross-directory resume check remains a separate spike.

## Live Kimi K3 results (2026-10-07)

The user explicitly authorized Kimi K3 or GLM 5.3 Flash through their coding
plans. Pi's existing Kimi credential was ready, so no new key had to be retrieved
or written. A no-model preflight checked the selected `kimi-coding/k3`, its
visibility in available models, and the exact `https://api.kimi.com/coding`
endpoint before any prompt. The live guard ran with both selection variables,
and every protocol child received explicit `--provider` and `--model` flags.

Environment: pi **1.0.4**, Linux x64, Bun **1.4.2** driver. The complete run took
about 40 seconds and sent five prompts. Headers and completed assistant messages
identify `kimi-coding/k3`; no Anthropic or OpenAI provider was used. Kimi uses the
Anthropic-compatible wire API, which does not mean billing Anthropic.

Raw, private artifacts are in
`build/spikes/S1-kimi-k3-20261007T021331Z/`: four stdout recordings, corresponding
command/exit traces and empty stderr logs, a passed `summary.json`, and four
native pi transcripts. The capture directory is 0700 and capture files are 0600.
These ignored artifacts are not curated replay fixtures or published evidence.

| Scenario | Raw result |
|---|---|
| Stream and continuation | Both turns ended with assistant `stop`, `agent_end {willRetry:false}`, and exactly one `agent_settled`. Native session ID/file stayed unchanged; the second answer recalled the first code. |
| Mid-text abort | `clear_queue` was acknowledged before sending `abort`. Assistant `aborted` → `turn_end` → `agent_end` → `agent_settled` → abort response. State was idle afterward. |
| Mid-tool abort | The wait tool reported its started marker before abort. Its `tool_execution_end` had `isError:true`. Raw assistant reasons were `toolUse`, then `error` with zero usage and `This operation was aborted`; `agent_settled` preceded the abort response. State was idle afterward. |
| SIGKILL mid-text | Signal exit, `code:null`, and no wire `agent_settled` or completed assistant. The transport must synthesize the outcome. |
| Orderly shutdown | All three non-killed children exited 0 on stdin close without escalation. |
| Retry/compaction | Zero events observed; ordering remains unverified. |

**Decision for the turn contract:** keep `agent_settled`, not the prompt response
or `agent_end`, as the native idle boundary. Keep the event subscription active
while awaiting an abort response: settlement can arrive first. Preserve explicit
user-abort intent independently of raw assistant stop reasons, because a genuine
mid-tool cancellation can end with raw `error`. The normalized result stays
`settled {stopReason:"aborted"}`. A killed child has no native settlement to relay,
so it becomes a synthesized error rather than a fabricated pi event. These are
verified observations for the cases and version above, not a guarantee about
unobserved retries, compactions, or future pi versions.

## Controlled native retry/compaction results (2026-10-07)

`scripts/spikes/rpc-controlled.ts` starts actual pi children, using the same
recording transport, against a bound `127.0.0.1` HTTP stub. It has **no remote
forwarding path**. The credential is an explicit non-secret dummy; child
environments omit real API keys, 1Password variables, proxies, and Node options.
Temporary agent profiles exclude saved auth and user configuration. All resources
and tools are disabled; offline mode and cache-warming/telemetry settings prevent
background activity. Both selection flags are explicit, and selected model plus
loopback base URL are checked before every prompt or compaction.

```sh
PREFAIX_LIVE_PROVIDER=kimi-coding \
PREFAIX_LIVE_MODEL=kimi-coding/k3 \
bun run spike:rpc-controlled --record build/spikes/S1-controlled-review
```

This API stub implements only the installed Kimi model's compatible wire format;
other allowed selections get a clear refusal. The usual live guard still runs
before artifacts, listening, version probes, or spawn. No key retrieval or billed
model request is necessary. Headers say `source: controlled` and name the stimulus;
injected test children still say `source: synthetic`.

The private native run is `build/spikes/S1-controlled-pi1.0.4-final/`, with
pi **1.0.4**, a passed summary, six stdout/trace/stderr sets, and native transcripts.
Earlier failed probe attempts remain separate, not overwritten or curated.
The stub scripts 503 failures, a 400 overflow, SSE answers and usage. Metadata
uses a 4096-token window, 2048-token reserve, zero retained recent tokens,
512-token output limit, reasoning off, and zero prices. Agent retry budget is
one, provider retry budget zero; cancellation uses a 30-second retry delay.
These are **stimuli, not measurements of K3's limits, usage, pricing, or text**.

| Case | Native ordering and outcome | Loopback requests |
|---|---|---:|
| Retry recovery | Assistant `error` → `agent_end {willRetry:true}` → `auto_retry_start` → new `agent_start` → assistant `stop` → `auto_retry_end {success:true}` → final `agent_end` → one `agent_settled` | 2 |
| Retry exhaustion | Same first failure/start; second assistant `error` → `agent_end {willRetry:false}` → `auto_retry_end {success:false}` → one settle | 2 |
| Abort retry delay | `auto_retry_start` → clear queue / abort → `auto_retry_end {success:false, finalError:"Retry cancelled"}` → one settle, before abort response. No second run; raw last reason stays `error`. | 1 |
| Threshold compaction | Successful assistant → `agent_end {willRetry:false}` → `compaction_start {reason:"threshold"}` → successful end with `willRetry:false` → one settle. A subsequent prompt also succeeds. | 3 |
| Overflow recovery | Seed turn succeeds. Next assistant `error` → `agent_end {willRetry:false}` → overflow compaction → successful end with `willRetry:true` → new `agent_start` → assistant `stop` → final end → one settle for that prompt. Two summary calls handle the split history. | 5 |
| Manual compaction | After an idle seed turn: `compaction_start {reason:"manual"}` → successful end with `willRetry:false` → compact response. **No new `agent_settled`.** | 2 |

Usage is cumulative **per assistant response**, not per prefaix turn; the raw
zero-usage error after tool cancellation demonstrates the reset. Reported
`cost.total` also includes cache charges, not just input/output costs. A separate
Beads follow-up tracks turn-level accounting and cache-cost normalization; the
settle/abort behavior tested here does not depend on that fix.

All six children exited 0 on stdin close without escalation; stderr was empty.
The 15 loopback requests used zero remote model requests. State was idle after
settlement and after manual compaction.

**Final turn decision:** the client must not release native turn ownership on
an assistant error, `agent_end`, `auto_retry_end`, or `compaction_end` alone.
Even **`agent_end {willRetry:false}` is not sufficient**: overflow recovery can
still start another run. Wait for `agent_settled` for a prompt-driven run, with
deadlines and synthesized failure on child exit. For manual compaction with no
active prompt, await the `compact` response rather than an event that never
comes. Explicit user cancellation wins over the raw terminal reason, including
a tool abort or aborted retry that leaves `error` on the wire. Existing pi-port
behavior follows this decision; replay tests lock it in.

## Reviewed replay fixtures

`test/fixtures/pi/recorded/` contains four live-derived fixtures (stream, text
abort, tool abort, SIGKILL) and six controlled-native fixtures (retry recovery,
exhaustion, cancellation; threshold, overflow, manual compaction). The original
root fixtures remain supplemental type-built cases, particularly UI and normal
built-in tools; they are not retroactively claimed as recordings.

Curation is reproducible and makes **no model request**:

```sh
bun scripts/spikes/rpc-curate.ts <passed-record-directory> <new-output-directory>
```

The curator refuses failed/synthetic captures, checks header/summary identity
and record ranges, and keeps a SHA-256 hash of the full raw file plus a half-open
record range excluding its header. It removes responses, paths in state records,
user/system messages, thinking, signatures, timestamps, opaque provider request
IDs, unused details, and duplicate `agent_end.messages`. Opaque tool/entry IDs
are normalized consistently. It does not rewrite native event order, raw stop
reasons, or physical provider/model identity. Private-data detection is a safety
check, not a substitute for reviewing the output before sharing it.

Replay holds wait for an actual abort before emitting cancellation records. The
replayer drains those records and acknowledges abort afterward, including on a
second turn; legacy fixtures retain their old behavior. The SIGKILL fixture ends
in an explicit replay hold, not a fabricated settlement. The stream has a
400ms replay pause for the contract's in-flight state query; this is not provider
latency. Manual compaction is replayed for `compact`, not `prompt`.

`test/contract/pi-recorded.test.ts` runs the same AgentPort contract with these
recorded lifecycle/retry cases; normal tool and UI scenarios explicitly retain
supplemental type fixtures. `test/unit/pi-recorded.test.ts` additionally checks
provenance/redaction, compaction continuations despite `willRetry:false`, manual
completion without settlement, raw-vs-normalized abort reasons, repeated causal
abort replay, and synthesized SIGKILL errors. Recorder and curator tests use
synthetic children/fixtures or a local HTTP stub, never a paid model.

## Current no-model results (2026-10-06)

On Linux with installed pi **1.0.4** and a Bun **1.4.2** driver:

- `bun run test:pi-smoke` passed without a prompt.
- A separate isolated RPC child loaded the S1 wait extension, answered
  `get_state` and `get_commands`, created an in-memory session, accepted an
  idle abort, and exited 0 on stdin close without escalation or stderr.
- That probe sent **zero model requests**. It verifies extension loading and
  transport/shutdown compatibility, not live turn or tool-execution behavior.
- pi's installed tool-argument validator accepted the wait tool's empty JSON
  Schema and rejected an unexpected argument, without a prompt or model request.

Local raw results are `build/spikes/S1-no-model-pi1.0.4.jsonl` and the adjacent
`.json` report. The report's `node` value is Bun's Node-compatibility version
string, not a measurement of pi's child runtime. These results do not replace
or retroactively broaden the original 0.87.1 observations above.
