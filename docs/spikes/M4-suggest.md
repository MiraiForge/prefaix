# M4-1 — Structured shell-command suggestions

## Candidate behavior

`:suggest <want>` / `:s <want>` sends an explicit edit request to the daemon.
The distinct `turn.suggest` operation prevents an older daemon from treating
this as an ordinary run turn. Grammar recognizes the edit class without
enabling unrelated M4 commands.

The pi bridge registers a model-only `propose_command` tool. It excludes that
tool from normal loadouts, activates it alone for an edit, adds shell-specific
system guidance, and restores the prior tool set at native settlement or the
next prompt after a local abort. Tool-call guards block non-proposal edit calls
and off-mode/nested proposals. This is **not a sandbox** for arbitrary extension
code or detached processes.

A successful tool returns `{command, explanation}` details and
`terminate: true`. The adapter accepts only paired successful top-level
completions, not raw arguments, failed calls, editor UI, or model prose.
Validation preserves literal syntax, Unicode, and multiline data while rejecting
empty commands and directive/terminal controls.

The daemon requires exactly one valid proposal and holds it until a successful
final outcome. Failure, truncation, abort (including Esc during finalization),
ambiguous proposals, or persistence/finalization failure yields no generated
buffer. The foreground accepts the buffer only from the successful final
summary, after its own metadata and tty cleanup succeed too. A late Esc or
post-turn metadata error withdraws the generated proposal; distinct user
typeahead is preserved. Shell plugins assign the
NUL-delimited directive as editable data; execution requires the user's Enter.

A configured `commands.suggest.model` is temporary. The daemon captures and
restores model/thinking under turn ownership before recording the outcome.
Restore failure discards the proposal, evicts the child, and never persists
the temporary selection. The conversation persona is retained; an edit
answer cannot make `:go` executable.

## Evidence

- Fake/socket regressions cover routing, model/thinking scope, partial switch
  failure, unavailable/ambiguous models, unsupported backends, failed restoration,
  malformed/duplicate proposals, settlement failures, persistence failure, and
  late abort.
- Scripted bridge/mapper/adapter tests cover exclusive tool activation,
  restoration, guards even after hook errors, readiness negotiation, paired
  results, editor-UI rejection, and literal slash-prefixed requests.
- Real shell PTYs cover scenario 10 on installed zsh, fish, and bash: the
  generated Unicode-writing command remains editable and creates no file,
  Ctrl+C cancels it, and explicit Enter creates the expected file. These local
  versions are not a claim about every supported native CI version.
- Actual pi **1.0.4** and **1.1.0**, each isolated with dummy credentials and
  guarded scripted loopback replies, complete normal → suggest → normal turns
  on one child. Each records exactly **3 local API requests, 0 remote requests**,
  one settlement per turn, no automatic follow-up after the terminating proposal,
  and no execution of the generated sentinel command.
- Request tool schemas and native transcript tool deltas agree:
  `bash/edit/read/write` → `propose_command` → `bash/edit/read/write`.

This is controlled adapter/tool/transcript proof, **not natural-model behavior**.
Dedicated-model restoration is covered by fake/socket tests, not an additional
claimed native multi-model probe. The first PATH-based capture found pi 1.1.0;
the second explicitly selected the pinned npm-prefix pi 1.0.4. Provenance:
[M4-suggest-native.json](M4-suggest-native.json). Private raw captures:
`build/spikes/suggest-native-final/` (1.1.0) and
`build/spikes/suggest-native-pi1.0.4/` (1.0.4).

## Reproduction

No native/model requests run in the normal test suite. For the opt-in recorder,
build first and explicitly select the allowed provider/model and desired pi
binary. The guard runs before native setup and before every prompt; the actual
selected native endpoint must be the loopback API.

```sh
PREFAIX_AGENT_PI_BIN=/path/to/tested/pi \
PREFAIX_LIVE_PROVIDER=kimi-coding \
PREFAIX_LIVE_MODEL=kimi-coding/k3 \
bun run spike:suggest-native -- build/spikes/suggest-native-new
```

The recorder disables user resources and uses an isolated HOME/profile, dummy
auth, offline pi, disabled retries/compaction/cache warming, and a loopback-only
Anthropic-shaped API owned by the test. It never uses paid Anthropic/OpenAI
providers or a default model.

Source and tests are a new local implementation candidate, not the accepted
`d2de470` main artifact. CI/review/merge remain separate gates; M3 human
acceptance and exact-version release approval remain outstanding.
`package.json` stays private at 0.0.0.
