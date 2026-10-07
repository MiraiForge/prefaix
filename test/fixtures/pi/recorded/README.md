# Reviewed S1 pi RPC fixtures

These are curated **native pi 1.0.4** stdout recordings, not hand-written protocol
examples. See `docs/spikes/S1-pi-rpc-lifecycle.md` for the method and conclusions.
The original files remain private in ignored `build/spikes/` directories.

| Source | Fixtures | Meaning |
|---|---|---|
| `live` | `stream`, `abort-text`, `abort-tool`, `kill-text` | Actual Kimi K3 coding-plan turns. |
| `controlled` | `retry-success`, `retry-exhausted`, `retry-abort`, `compact-threshold`, `compact-overflow`, `compact-manual` | Actual pi processes against a loopback HTTP/SSE stub. Failures, answers, usage, limits, and zero prices are scripted; no remote model requests or real credentials. |

Each JSONL starts with a `prefaix_fixture_header`. Its SHA-256 identifies the full
original raw capture, including that capture's header. `recordRange` is half-open
and indexes raw records **excluding** the header. The provider/model identify the
selected pi backend; `controlled` does **not** mean real Kimi errors or summaries.

Curation removes responses/state, user/system messages, thinking, signatures,
timestamps, opaque provider request IDs, unused details, and duplicate agent-end
messages. Tool/entry IDs are normalized consistently. Native event order, stop
reasons, provider/model identity, and usage fields remain observable. Raw live
costs are catalog estimates, not a measurement of coding-plan charges.

The child replayer ignores fixture headers and understands these explicit controls:

- `untilCommand: "abort"` holds the terminal records until an abort arrives.
  `replay.abort: "drain"` emits those records before acknowledging abort, including
  when the fixture is played again. Old type-built fixtures keep their old behavior.
- `untilCommand: "prefaix_fixture_kill"` holds the unfinished SIGKILL turn until the
  parent kills the child. There is deliberately no fabricated `agent_settled`.
- The stream's 400ms pause lets the contract observe an in-flight turn. It is
  **replay pacing, not measured provider latency**.
- `replay.command: "compact"` plays the manual-compaction fixture for that command
  and responds with its result. It has no new `agent_settled`.

Regenerate into a **new** directory with `scripts/spikes/rpc-curate.ts`, review
private-data removal, then explicitly copy the approved outputs here. Curation
refuses failed runs, synthetic injected children, unsafe scenario names, mismatched
headers, and invalid ranges. It never overwrites raw evidence. Automated pattern
checks are not a substitute for review.

The root `test/fixtures/pi/*.jsonl` files remain supplemental type-built inputs,
including UI and normal built-in tool examples. The recorded contract target
identifies those supplements explicitly; S9's recorded UI evidence is separate.
