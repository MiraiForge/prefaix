# M4-5 — Conversation personas

## Decision

Ship `:ask <question>`, `:plan <task>`, configured `:<persona> <text>`, and
`:go`. Persona selection persists with the conversation, not with a particular
client process. Ordinary prompts, environment respawn, and idle eviction retain
it. `:go` restores the backend's normal tools and removes the guideline while
continuing the same native transcript.

A successful, nonempty planning answer marks the plan executable. Starting
another turn invalidates that marker until another planning answer completes.
`:go` takes no arguments, checks the latest marker after claiming turn ownership,
and refuses missing, failed, consumed, or cross-workspace plans. This prevents
cwd splitting or a second shell from making it execute a different plan.

Personas remain a convenience, **not a sandbox or security boundary**.

## Controlled native evidence: 2026-10-08 (post-review)

The [reviewed report](M4-personas-pi1.0.4.json) records actual pi **1.0.4** on
Linux x64, spawned through `PiAdapter` and `AgentPool`. The harness uses an
isolated profile/HOME, dummy credentials, no user extensions or skills, pinned
provider/model flags, and a **loopback-only SSE stub**. Seven HTTP requests reach
that stub; **zero remote model requests**. Answers, usage, and provider failures
are not natural-model evidence.

| Turn | Actual offered tools |
|---|---|
| Independent normal baseline | `bash, edit, read, write` |
| Fresh child opened directly with `plan` | `find, grep, ls, read` |
| Switch to `ask` | `find, grep, ls, read` |
| Custom `audit` | `read` |
| Guideline-only `review` | `bash, edit, read, write` |
| Return to `plan` | `find, grep, ls, read` |
| Clear persona and execute plan | `bash, edit, read, write` |

All six persona/execution turns use **the same child pid and session**. Visible
user messages are unchanged. Reconstructing pi's recorded
`toolsAdded`/`toolsRemoved` system deltas at each user message yields exactly
the same tool sets as the API schemas. The final system delta removes the
persona section (`persona: null`) and restores modifying tools.

The post-review probe also removes the runtime turns directory after the fresh
planning child's bridge is ready. The adapter yields exactly one local
`settled(error)` without sending the prompt: zero new loopback requests, and no
failed user message in the native transcript. Restoring the directory allows
the same child to complete all six persona/execution turns. This is proof of
fail-closed context delivery, not native abort or dialog-cancellation evidence.

Raw captures and native sessions remain under
`build/spikes/personas-native-codex-review/` (gitignored); the public report keeps
tool names/provenance and SHA-256 hashes, not private raw transcripts. Initial
probe attempts are retained separately. Their assertions incorrectly searched
JSON-escaped text and a non-native tool-section heading; the final harness
checks actual sections and reconstructs schema deltas instead.

Reproduce without using pi's configured provider or real credentials:

```sh
PREFAIX_LIVE_PROVIDER=kimi-coding \
PREFAIX_LIVE_MODEL=kimi-coding/k3 \
bun run spike:personas-native -- build/spikes/personas-native-new
```

The script runs the live guard before spawning or making requests, refuses
other provider/model pairs before constructing a profile, and verifies the
actual selected model before every prompt. Explicit `--provider` and `--model`
are passed to pi. The public pair names the locally overridden loopback model,
not Kimi's remote service.

## Regressions and fixes

- **Native restore baseline:** a bridge-enabled persona spawn must start with
  normal tools. Narrowing at spawn captures the wrong baseline and leaves
  `:go` read-only. If the configured bridge fails to load, restart once with
  spawn-time tools **before any prompt**. Per-child unsupported switches resume
  the native handle in a replacement child.
- **Per-turn context failure:** if a live bridge cannot receive its turn file,
  refuse the prompt rather than substituting persona prose for enforced tools.
  This also prevents a failed persona-clear from leaving stale restrictions.
  Restoring runtime storage allows the next turn on the same child.
- **Plan startup failure:** invalidate the previous executable-plan marker
  after claiming ownership and before opening or acquiring a backend. Failed
  revision, ordinary continuation, and execution startups cannot expose an old
  plan to `:go`.
- **Retained-persona races:** re-read the conversation under turn ownership
  before resolving an omitted persona or native handle. A prompt delayed by
  workspace routing cannot resurrect `plan` after another shell finishes `:go`;
  explicit persona changes still apply as requested. Under `follow`, preserve
  the caller's routed root while refreshing the latest state, so another
  shell's completed move cannot redirect a delayed prompt to its workspace.
- **Guideline-only personas:** switching from a restricted persona restores
  normal tools rather than accidentally inheriting the previous restrictions.
- **Config map defaults:** adding a custom persona retains built-ins. Defining
  a built-in entry replaces only that entry, with no surprising field merge.
  Inherited object properties are not persona names.
- **Bash warm reuse:** the new cross-shell PTY assertion exposed exported
  `READLINE_POINT` changing with prompt length on bash 5.3.20. Ignore transient
  `READLINE_LINE`, `READLINE_POINT`, `READLINE_MARK`, and `READLINE_ARGUMENT`
  in the environment fingerprint. Real environment changes still respawn.
  This is tracked by child bead `prefaix-1gf.5.1`.
- **Routing and errors:** bare personas require prompt text; unknown tight names
  suggest configured personas as well as commands. Built-in command/alias
  names take precedence over colliding custom persona names.

Fake/socket tests cover persistence, explicit clearing, custom configuration,
failed/empty plans, cold resume, invalid requests, workspace isolation,
backend-startup failures, and stale-plan/persona races. Scripted-child tests
verify bridge startup, fallback spawn arguments, and no prompt before
restrictions. The real shell command PTYs
verify ask/custom/plan/go and warm child identity on zsh, fish, and bash.
The standard contracts continue to run against fake, replay, and a deliberately
broken backend. The final Codex review reports no actionable defects;
[post-review validation](../VALIDATION.md#m4-codex-review-hardening-2026-10-08)
records the complete local gates and final performance measurements.

This evidence does not close M3's human/release gates, validate long-held native
dialog cancellation, or authorize publication.
