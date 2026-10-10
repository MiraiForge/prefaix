# M3 validation

Beads epic `prefaix-mbd` owns the acceptance record. Passing local tests is not
proof of Linux CI, a three-day user trial, or publication.

## Green exact-head CI and main protection: 2026-10-08

[CI run 37733087814](https://github.com/MiraiForge/prefaix/actions/runs/37733087814)
is **green, attempt 1**, at
`d2de470fbdfacd2ef6fcff6e62c2cfbba2b462cc`: all **18 jobs** passed. Six
functional/coverage, six performance, four native shell-version jobs, the
current pi **1.0.4** no-model smoke, and the required-check aggregate are green.
All enforced coverage thresholds remain at 95% or better.

Four **50/50** frozen stability gates cover Linux/macOS with bash 4.4/fish
3.6.4 and bash 5.2/fish 4.0.2, stock zsh 5.9, and the macOS bash 3.2 fallback.
All **200 logs** were audited: **zero failed reruns**, **14,500 passing
assertions** (73 per macOS repeat, 72 per Linux repeat), one worker per matrix.
No retries, omitted failures, relaxed budgets, or new memory exceptions were
used. The existing Node 26 idle-RSS exception remains explicit; only macOS
Node 26 used it in this run.

All six performance reports and four stability summaries identify production
artifact `48d7421fedf638cee320204bace453d9998e9d52d891c0c3eb1666ad20bb3326`.
The source/test/dependency stability fingerprint is
`3c65b9df70ac676bd0ab651f4a99365ad9a784055809adf27dfef23147aea2b9`.
macOS 15 Node 22 hello p50/p95 is **36.10/42.20ms**, warm first-token
**61.18/69.96ms**, maximum idle RSS **47.59MiB**, and slowest burst **10,187
deltas/s**. Original <60ms/<100ms timing and 60,000,000-byte memory budgets pass.
Linux Node 22 hello is **37.59/40.86ms**, first-token **54.92/58.38ms**.

[Reviewed report/log hashes and provenance](spikes/CI-37733087814.json) retain
all matrix summaries and hashes of the twelve original startup/performance
reports and 200 logs. Raw reports retain every sample in the public CI artifacts;
local copies are `build/ci-d2de470-{startup,performance,stability-final}/`.
The S8 socket-loader comparison is not production or natural-provider latency.

After this exact head was green, authorized main protection was configured and
read back: strict **`M3 required checks`**, bound to GitHub Actions app 15368,
including administrators; force pushes and deletion blocked. No review count
or publishing policy was added. Future changes use PRs. This validates the
specified code/artifact, not later changes, a final release, human doctor/
walkthrough/three-day acceptance, or publishing approval. The package remains
private `0.0.0`; no release tag, publication, deployment, or remote model request
occurred in this CI collection.

The intermediate [run 37728405897](https://github.com/MiraiForge/prefaix/actions/runs/37728405897)
at `a2935e6` passed every required matrix and all 200 stability reruns, but the
optional smoke failed during npm installation: the retired
`@mariozechner/pi-coding-agent@0.87.1` pin was unavailable (ETARGET). The final
commit pins the official current `@earendil-works/pi-coding-agent@1.0.4` with
`--ignore-scripts` and updates doctor guidance without changing its supported-
version floor. A fresh full matrix, not a retry or skipped optional job, proves
the correction. The original failed run and logs remain retained.

## CI and native dialog follow-up: 2026-10-08

Historical pre-delivery candidate record; superseded for CI/protection status
by the exact-head evidence above, not erased as measurement or regression proof.

Earlier [CI run 37719207492](https://github.com/MiraiForge/prefaix/actions/runs/37719207492)
failed at `e2aaa27`. Ubuntu Node 22 coverage let the busy fake turn finish
before Ctrl+C (exit 0 instead of 130). macOS 15 Node 22 reported hello p50
**67.87ms** and first-token p50 **115.80ms**, exceeding the unchanged <60ms and
<100ms budgets. Its required-check aggregate consequently failed. The older
green run below does not supersede this failure.

The local candidate replaces elapsed-time ownership in that test with a gated
real FakeSession prompt, released only by the actual `turn.abort` acknowledgment.
Normal and 2,000ms metadata delays pass; removing the gate reproduces the same
0-versus-130 failure. The package now builds one standalone foreground ESM
module while retaining lazy split daemon/adapter bundles. Warm unchanged
conversation/native/persona state avoids redundant fsyncs, but changed handles,
root/title/persona, and executable-plan invalidation remain durable before any
prompt/backend side effect. Regression tests enforce lazy initialization,
standalone execution, and the durability boundaries.

Linux Node 22.23.3 candidate measurements retained all 50 samples and the
original budgets: hello p50/p95 **26.52/29.99ms**, first-token p50/p95
**43.63/46.70ms**. A whole-application unsplit experiment was slower and was
rejected. The retained report is
`build/ci-e2aaa27-performance/local-node22-foreground-noop.json`; it predates the
separate dialog hardening below. Linux results are not native macOS validation
or proof that latest-main CI is repaired.

[Separate actual pi 1.0.4 native dialog evidence](spikes/native-dialogs.md)
reproduces the old 500ms prompt deadline during a 1,500ms human question and
verifies the correction: pause acceptance, retain metadata deadlines, hard-stop
an unanswered-dialog child on signal/method abort, and resume its native
conversation. A silent 2,000ms preflight is also terminated at the ordinary
500ms deadline, with zero late requests. Seven turns make four scripted local
API requests, **zero remote requests**, and exactly one settlement each. Actual
PID disappearance and native transcript/state are checked; only the four
successful user messages enter the transcript. This is safe termination and
replacement, not graceful hook cancellation or arbitrary extension sandboxing.

Current local gates:

- Full check: **1,911 passed**, 10 deliberate expected contract failures,
  10 optional skips.
- Explicit Linux Node 22.23.3 full coverage: **97.83% statements, 95.76%
  branches, 96.04% functions, 98.16% lines**; all enforced 95% thresholds pass.
- Full shell PTY suite: **125 passed**, 19 optional skips on the available
  Linux shell versions.
- Eighteen scripted dialog/deadline/lifecycle regressions and six cost-guard
  refusal cases run without invoking native pi or a model. The guarded native
  evidence is captured separately under `build/spikes/dialogs-native-guarded-final/`.

The final candidate also passes a fresh Linux Node 22.23.3 production performance
run: hello p50/p95 **27.33/32.78ms**, first-token p50/p95 **44.54/49.52ms**,
slowest burst **32,476 deltas/s**, and maximum idle RSS **56.17MiB**, physically
below the 57.22MiB budget without an exception. All 50 samples are retained in
`build/ci-e2aaa27-performance/local-node22-ci-dialog-final.json`.

Two frozen local sweeps each pass **50/50**, 72 cases per repeat, **7,200 test
passes** total, with four workers each, zero retries/omitted failures, and every
log audited. Available shells are zsh 5.9.2, fish 4.9.3, and bash 5.3.20, not the
CI floor/version pairs. The first sweep used a Node 22 parent but default
Node 26.10.0 CLI/test workers; its report's `node` field identifies only the
parent. The second explicitly prepended Node 22.23.3 to PATH for all workers.
Raw evidence is `build/flake-ci-native-dialogs{,-node22}/`. Both sweeps and the
final performance report identify artifact
`a999ab1c6f2965b3270546cce10e8bb55a78d36763263159c193a39207fa6406`;
the stability source/test/dependency fingerprint is
`ceaac29e2ba3b2320e673c0cde8922903943e172cb2f9609af887949e76cb43d`.
These local sweeps are not frozen release-artifact acceptance across the full
supported OS/version matrix. The recorder uses local Bun 1.4.2 rather than
CI's pinned 1.3.14; native and performance runtime scopes remain explicit.

At this pre-delivery collection point, `main` was unprotected: a read-only
branch-protection query returned 404 and the repository ruleset list was empty.
The later approved exact-head CI and protection evidence above supersedes
this status. No commit/push, remote policy
change, tag, publishing, deployment, or paid recording is implied by this local
work. Fresh exact-commit CI, required-check enforcement, frozen release-artifact
stability across all supported OS/version entries, human doctor/walkthrough/
three-day trial, and explicit release approval remain distinct gates.

## Native CI evidence: 2026-10-07

[CI run 37573150805](https://github.com/MiraiForge/prefaix/actions/runs/37573150805)
is **green, attempt 2**, at committed
`72d512bf1615d63ba0997c6c895a07725f551757`. Attempt 1's macOS Node 24
PTY job was interrupted by runner shutdown (exit 143), not a reported assertion.
The rerun and required-check aggregator passed. All six check entries, four
native shell/version entries, and six performance entries are successful;
the optional pi no-model smoke was skipped.

This supersedes older **pending Linux/S8 comparison** notes below, not their
historical measurements. It validates that committed artifact, **not** the
subsequent provider/usage/bridge/resume implementation. Required
branch-check enforcement, frozen release-artifact stability, human acceptance,
and publishing authorization are separate.

[Reviewed raw CI reports and SHA-256 manifest](spikes/CI-37573150805.json)
retain the original file hashes and every sample from all twelve
startup/performance artifacts. Originals are under
`build/m3-validation/ci-37573150805/`. All performance reports identify built
artifact `270d6a4db692ea80840fee970e9a2865ef222f32ac1220b91a01c69ed71096f0`.

Each production entry has 50 warm measured turns after one excluded warmup,
then three 2,000-delta bursts. Post-use/post-burst RSS follows five seconds of
quiescence. The backend is FakeAgent; **zero model requests**.

| Platform / Node | Hello p50 / p95, ms | First token p50 / p95, ms | Fresh / post-use / post-burst RSS, MiB | Slowest burst deltas/s |
|---|---|---|---|---|
| macOS 15 / 22.23.2 | 57.95 / 87.60 | 94.68 / 133.03 | 44.56 / 47.11 / 48.05 | 10,672 |
| macOS 15 / 24.20.0 | 37.53 / 45.12 | 64.84 / 76.59 | 48.45 / 51.59 / 52.34 | 16,990 |
| macOS 15 / 26.10.0 | 38.56 / 44.07 | 67.13 / 76.32 | 53.88 / **58.44 / 59.06** | 16,710 |
| Ubuntu 24.04 / 22.23.3 | 39.54 / 42.98 | 60.05 / 187.26 | 50.34 / 52.33 / 53.27 | 18,196 |
| Ubuntu 24.04 / 24.21.0 | 27.45 / 31.30 | 45.66 / 49.28 | 50.46 / 53.74 / 54.34 | 26,322 |
| Ubuntu 24.04 / 26.10.0 | 42.00 / 44.40 | 61.67 / 64.11 | 51.64 / 55.89 / 55.90 | 17,618 |

Every timing/throughput gate passes: hello p50 <60ms/p95 <120ms, first-token
**p50** <100ms, and >1,000 deltas/s. First-token p95 is reported, not subject
to an invented <100ms gate. macOS Node 26 post-use/post-burst RSS exceeds
60,000,000 bytes (57.22MiB) and is honestly **allowlisted**, not physically
under budget. The other entries, including Ubuntu Node 26, pass the RSS limit.

[S8](spikes/S8-client-startup.md) now resolves the packaging decision using
native macOS/Linux paired stub results: retain bundled Node. A compiled Bun
stub is slower on Linux and does not repair daemon RSS.

The subsequent [M1 native report](spikes/M1-native-pi1.0.4.json) and S2–S9
writeups distinguish controlled native pi, replay, and shell/TTY evidence.
A native successful pre-ack dialog is verified; long-held native dialog
timeout/cancellation remains separate hardening. Neither the matrix rerun nor
new local probes substitute for the required human trial or authorize release.

The subsequent implementation also passes a separate local Linux Node
26.10.0 production gate (50 measured turns): hello p50/p95 **32.31/37.20ms**,
first token p50 **50.36ms**, slowest burst **25,933 deltas/s**, and fresh/
post-use/post-burst RSS **49.00/53.86/54.62MiB**, with no memory exception.
Its artifact hash is
`8e6761e5c0b93db1b12c4371598908f75f49731a51ffc95d8f907e8fd01c754e`;
raw report: `build/m3-validation/final-local-performance.json`. This local
pass does not make the old committed CI artifact validate the new source.

## M4 Codex review hardening: 2026-10-08

Codex 0.160.1 uses `codex review --uncommitted`, not the old `--review` flag.
Three passes ran with `-s read-only -a never`: the first found three defects,
the second found a follow-policy routing race in the state-refresh fix, and the
last reported **no actionable defects**. The reviewer passed lint, formatting,
typechecking, and read-only smoke assertions; its sandbox blocked Vitest's
temporary config file, so the complete suites were run separately below.

All four findings are fixed:

- A live pi bridge that cannot receive a turn file now refuses before sending
  any prompt, rather than exposing normal tools for a read-only persona or
  retaining stale restrictions during restoration.
- A completed-plan marker is invalidated under ownership before fallible
  backend acquisition. Failed planning, continuation, or execution startup
  cannot leave the previous plan executable.
- Persona and native state are refreshed under ownership, preventing a delayed
  ordinary prompt from resurrecting `plan` after another shell's `:go`.
- Under `workspace.cwd_policy = "follow"`, the caller's routed root survives
  that refresh; another shell's move cannot redirect the delayed prompt.

Twelve added regression cases cover these findings; before-fix runs reproduced
ten failures. Validation also exposed two pre-existing stale-lock tests whose
guessed PID `999999` was live during the run. Their fixtures now use a value
outside supported Linux/macOS PID ranges; production lock behavior is unchanged.

Final local validation after all fixes:

- `bun run check`: 1,880 passed, 10 deliberate expected contract failures,
  10 optional skips.
- `bun run coverage`: statements 97.81%, branches 95.82%, functions 96.00%,
  lines 98.13%; all 95% enforced thresholds pass.
- `bun run test:e2e`: 125 passed, 19 optional skips. The five-case command
  suite also passes separately on fish and bash, in addition to default zsh.
- Native pi 1.0.4 loopback proof: a missing turns directory after bridge
  readiness produces one local error settlement, zero new API requests, and no
  failed user message in the native transcript. Restoring it recovers on the
  same child. The seven successful scripted requests remain loopback-only:
  **zero remote native model requests**. Public evidence:
  [M4-personas.md](spikes/M4-personas.md) and its provenance JSON.
- `bun run test:perf`: hello p50/p95 30.79/34.45ms; first token
  48.64/52.97ms. All throughput and idle-memory gates pass without using the
  Node 26 exception.
- `bun run docs:check`, `bun run check:private`, formatting, and
  `git diff --check` pass.

Review logs remain gitignored under
`build/reviews/codex-personas-{initial,followup,final}.log`; raw native and
performance evidence is in `build/spikes/personas-native-codex-review/`.
This review does not complete the M3 human or release gates, authorize
publishing, or prove natural-model behavior.

## M4 persona implementation: 2026-10-07

[M4-5 evidence](spikes/M4-personas.md) verifies built-in/custom personas and
normal-tool restoration through actual pi 1.0.4, PiAdapter, and AgentPool.
The isolated loopback probe makes seven scripted local API requests and zero
remote model requests. Native transcript schema deltas match the offered tools
on every turn; visible prompts and the child/session identity are preserved.

Local Linux validation on Node 26.10.0 and Bun 1.4.2:

- `bun run check`: **1,868 passed**, 10 deliberate expected contract failures,
  and 10 optional skips.
- `bun run coverage`: statements **97.77%**, branches **95.76%**, functions
  **95.90%**, lines **98.09%**; all enforced 95% thresholds pass.
- `bun run test:e2e`: **125 passed**, 19 optional cases skipped. The five-case
  command suite also passes independently on fish and bash, including the
  persona/plan/go warm-child assertion. Measured shells: zsh 5.9.2, fish 4.9.3,
  bash 5.3.20. This is not a substitute for the supported-version/OS CI matrix.
- `bun run test:perf`: 50 measured turns; hello p50/p95
  **31.52/36.49ms**, first token p50/p95 **49.75/55.83ms**.
  Fresh/post-use RSS **48.98/53.89MiB**; all three memory states and throughput
  pass without using the Node 26 exception.
- `bun run docs:check`, `bun run check:private`, and `git diff --check` pass.

Performance artifact:
`335d8f0e2daf8baf84e82c72d2f30c406716b08410ebb19df8c3d4d11e1fadca`.
Local report: `build/spikes/personas-native-m4-final/performance.json`.

These are local implementation results, not new remote CI or release approval.
M3 human walkthrough/daily-use gates and frozen release-artifact validation
remain separate.

## Automated gates

Run `bun run check`, `bun run coverage`, `bun run test:e2e`, `bun run test:perf`,
and `bun run docs:check`. The contract tests run as part of `check` and coverage.
The deliberate broken backend must still fail the contract assertions.

The shared shell PTY suite uses node-pty and an xterm headless screen. It checks
normal commands and multiline continuation, history, conversation continuation,
new/switch, abort and tty restoration, typeahead, literal prompt transport,
builtin passthrough, refresh, vi bindings, and daemon-crash recovery. Fixtures
exercise directive readers with nonce mismatches and literal shell metacharacters.
Prompt helpers and ordinary commands must work without a PATH executable.
Fish 3.6's native history merge only sees new entries after its next whole-second
boundary. The plugin persists the literal line before streaming, then merges
until the latest NUL-framed history entry equals that complete line. This uses
the existing eleven 100 ms waits after the client has finished; readiness comes
from fish's history state rather than a separate `date` process. A short fish
3.x turn can add about one second before returning to the prompt. Fish 4.x
normally imports the entry on the first merge.

Supported version binaries can be selected with `PREFAIX_E2E_ZSH`,
`PREFAIX_E2E_FISH`, and `PREFAIX_E2E_BASH`. `PREFAIX_E2E_SHELLS=zsh,fish,bash`
selects the shells and `PREFAIX_E2E_REQUIRED=1` makes unavailable required shells
fail instead of silently reducing coverage.

CI is configured for Node 22, 24, and 26 on macOS and Ubuntu, plus these native version pairs on
both operating systems:

| bash | fish | zsh |
|---|---|---|
| 4.4 | 3.6.4 | OS-provided 5.8+ |
| 5.2 | 4.0.2 | OS-provided 5.8+ |

macOS also exercises `/bin/bash` 3.2's degraded `pfx` command. Version builds use
`scripts/install-test-shell.mjs`, which downloads official source archives and
checks pinned SHA-256 digests. They run natively on both OSes instead of placing
old bash inside a Linux-only container. Compatibility adjustments for modern
build tools are explicit in that script: CMake's reserved test-target name,
a libc++ macro collision, and fish 4.0's existing portable pipe fallback on new
Darwin SDKs. They do not change shell interception behavior.

Example isolated installation and invocation:

```sh
node scripts/install-test-shell.mjs bash 4.4 /tmp/prefaix-bash44
node scripts/install-test-shell.mjs fish 3.6.4 /tmp/prefaix-fish36
PREFAIX_E2E_BASH=/tmp/prefaix-bash44/bin/bash \
PREFAIX_E2E_FISH=/tmp/prefaix-fish36/bin/fish \
PREFAIX_E2E_REQUIRED=1 bun run test:e2e
```

Build prerequisites are a C/C++ compiler, make, CMake, ncurses, PCRE2, gettext,
and Rust for fish 4.x. The CI workflow installs the platform packages.

## Stability and timing

`bun run test:flake` runs the plugin, command, and setup suites 50 times and
saves each log plus `summary.json` under `build/flake`. The gate fails at 1% or
more failures, so 50 runs require zero failures. CI's manual `flake_gate` input
runs this for every supported OS/version pair; release tags require it too.
Runs are sequential by default. On a machine with sufficient resources,
`PREFAIX_FLAKE_CONCURRENCY=4` runs four isolated suites at a time. The report
records that setting and fingerprints the build, test inputs, package manifest,
and dependency lockfile; changing
either invalidates the sweep. Parallel workers do not retry or omit failures.

`bun run test:perf` uses the built Node CLI, a real daemon with the fake backend,
and a transparent Unix-socket proxy to observe daemon hello. It records 50 warm
samples after one excluded warmup. The first-token timing includes the fake's
pacing and the renderer. It asserts hello p50 <60ms, hello p95 <120ms, first-token
p50 <100ms, and daemon RSS <60 MB (60,000,000 bytes, or 57.22MiB) before use,
after 51 ordinary turns, and after
three 2,000-delta bursts. Both post-use measurements follow five seconds without
clients. No collection is forced. This isolates
overhead from a live provider's latency; it sends no model requests.
`PREFAIX_PERF_REPORT=/path.json` saves timings, all three idle measurements, runtime
and hardware details, and a SHA-256 digest of every built artifact. A concurrent
build invalidates the run.

A separate real daemon then serves three timer-free fake bursts of 2,000 text
deltas each through the built client. The gate verifies every rendered delta in
order and requires more than 1,000 deltas/second even including client startup
and persistence. Post-burst idle RSS must also meet the memory budget; replay
history does not exempt it. Allan explicitly approved an exception for Node
major 26 only: all RSS measurements remain in the report, and over-budget
results are labeled `idleMemoryBudget.status = "allowlisted"`. Every timing and
throughput assertion and other runtime memory budget stays enforced. Invalid
RSS samples fail even on Node 26. This approved exception removes the Node 26
RSS blocker; Linux measurements are now available in the 2026-10-07 evidence above. A diagnostic forced collection
reduced live heap but did not reduce RSS; the overrun cannot be attributed
solely to retained replay data. No forced collection or diagnostic runtime
override is shipped. Normal-command and prompt-draw process budgets are
asserted in the shell suite rather than inferred from client timings.

Socket streaming and replay respect writable backpressure. The event producer
waits for capacity instead of continuing to queue writes for a slow reader.
Tests verify exact delivery on resume, release on disconnect, half-close, local
close or abort, and replay metadata captured consistently before waiting. These
changes reduce burst memory but do not yet bring Node 26 below the idle budget.

The production bundle uses local ESM chunks and bundled TOML parsing; distribute
all of `dist`, including `pi-bridge.js` and its chunks. Backend adapters and
expensive Node native modules load only when needed. Packaged-artifact tests
copy `dist` into an isolated package without a source tree or `node_modules` and
exercise the CLI, bridge import, foreground daemon, and daemon autospawn.

Before opening daemon resources, the Node entry uses `process.execve` to apply
`--jitless --max-semi-space-size=1` to the daemon only. This keeps the same PID
and stdio without a supervisor. The settings reduce code and young-generation
memory at the cost of peak JavaScript compute throughput. The bounded streaming
test checks that the remaining throughput comfortably exceeds its gate.
Clients and pi keep their normal runtime settings; prefaix does not alter
`NODE_OPTIONS`. Explicit Node command-line choices are preserved. Unsupported
runtimes receive an actionable error; supported daemons require Node 22.19+
on macOS or Linux with `process.execve` available.

`bun run test:pi-smoke` starts installed pi in RPC mode with no session, no user
extensions, and no model prompt. CI offers it as the optional `pi_smoke` job.

## Restart and worker cleanup (2026-09-30)

Beads `prefaix-mbd.14` through `.16` are implemented and closed locally. The
M3 implementation is committed locally as `a281c7d`. The validated artifact digest is
`4a9434ed1e487887744f59cea64205b920b5e85f3b0f1aec3e44022ad205a96f`.

The regressions cover concurrent record writes and failure recovery, early native
handle persistence, reconstructing daemon state and reopening its saved native
reference, keeping ownership through finalization, pending-start and write drains,
log-write drains, connected-client idle cleanup, replay retention, and concurrent
renames during child startup. Pool tests cover spare adoption, active eviction,
pending-open capacity, dead-child replacement, failed-close ownership, shutdown
races, and persona restrictions. They use stubs and recorded fixtures, with no
model prompts. Cold-resume assertions verify the AgentPort native-reference
boundary; they do not simulate every possible pi transcript crash point.

A packaged import regression also keeps crypto and other expensive native
modules lazy before daemon resources open. The temporary-file UUID lookup occurs
inside the write, preserving the existing runtime policy.

| Check | Current local result |
|---|---|
| Full check | Lint/typecheck pass; 1,672 tests pass, 10 expected broken-contract failures, 10 optional skips |
| Coverage | 97.88% statements, 95.86% branches, 96.03% functions, 98.19% lines |
| Native shell matrices | 122 passing E2E tests each on Node 22.19/bash 4.4/fish 3.6.4 and Node 24.21/bash 5.2/fish 4.0.2; 7 optional iTerm skips each; both include zsh 5.9 and bash 3.2 fallback |
| Clean package install | Private 0.0.0 tarball version, all three init outputs, and a fake turn pass |
| Installed pi 0.99.1 | No-model RPC smoke passes |
| Docs and privacy | Generated config reference, privacy guard, and whitespace checks pass |
| Stability | Fresh frozen sweeps pass 50/50 each: 7,100 repeated tests, zero failures, four workers per matrix. Failed and superseded attempts remain separate |

`daemon stop` acknowledges a shutdown request. The isolated package check waits
for the daemon lock to disappear before removing its temporary HOME. The daemon
itself drains outcome and log writes before releasing that lock.

| Node | Hello p50 / p95 (ms) | First token p50 (ms) | Fresh / ordinary idle (MiB) | Burst deltas/s, slowest | Post-burst idle (MiB) |
|---|---|---|---|---|---|
| v22.19.0 | 32.60 / 34.13 | 67.98 | 45.67 / 46.72 | 18,666 | 49.14 |
| v24.21.0 | 34.21 / 36.76 | 68.82 | 50.53 / 53.91 | 17,207 | 54.61 |
| v26.7.0 | 35.49 / 37.71 | 70.11 | 56.53 / 60.00 | 18,407 | 60.47 |

These isolated final runs use the artifact above, 50 samples per runtime,
and the unchanged performance assertions. Node 22 and 24 pass every budget.
Node 26 passes timing and throughput but fails ordinary/post-burst idle RSS at
60.00/60.47MiB against the literal 60,000,000-byte limit (57.22MiB). Its fresh
idle RSS is 56.53MiB. These strict-gate runs preceded Allan's explicit Node 26
allowlist approval; the measured overrun is now an accepted exception. No forced
collection was used. Raw pre-exception reports are
`build/m3-validation/lifecycle-performance-node{22,24,26}.json`.

After Allan approved the Node 26 exception, fresh 50-sample runs on the same
artifact passed with the following explicit memory outcomes:

| Node | Memory status | Hello p50 / p95 (ms) | First token p50 (ms) | Fresh / ordinary idle (MiB) | Burst deltas/s, slowest | Post-burst idle (MiB) |
|---|---|---|---|---|---|---|
| v24.21.0 | `passed` | 38.38 / 43.22 | 72.59 | 50.33 / 53.86 | 19,653 | 54.50 |
| v26.7.0 | `allowlisted` | 38.32 / 43.63 | 73.11 | 56.17 / 59.59 | 19,817 | 60.41 |

Both runs exited successfully and passed the original timing, throughput, exact
output, and artifact-integrity assertions. Node 24 needed no exception. Thirteen
policy tests verify the Node 26 exception, strict original limits for other
majors, and rejection of invalid RSS. The Node 26 exception test failed before
the policy change and passed afterward. Reports are
`build/m3-validation/allowlist-performance-node{24,26}.json`.

The first fresh lifecycle stability attempt completed 50 repeats on each native
matrix. The older matrix passed 50/50; the newer one passed 49/50, failing its
<1% gate at 2%. Newer run 19 timed out after Ctrl+C in fish's invalid-config
recovery test. Its screen match did not reliably establish editor input
readiness. The test now waits for a bracketed paste to be handled by the editor
before cancelling the restored buffer, and checks that neither buffer executes.
No delay or retry replaces that input acknowledgment. The focused case passes
on all three shells in both native matrices; full check passes 1,672 tests.
The failed attempt is retained in `build/flake-lifecycle-{low,high}` and does
not count toward final stability. A subsequent attempt in
`build/flake-ready-{low,high}` exposed zsh fixture assertions running before
the client call log existed (older runs 1 and 4). Positive invocation assertions
now wait for the recorded call count, then check the prompt and exact arguments.
This waits for observable work without repeating the command or retrying tests.
Transient fixture stdout is unsuitable because shell repaint can remove it.

Older run 6 separately failed during fish 3.6.4 startup with
`No TTY for interactive shell (tcgetpgrp failed)` and `setpgid: Inappropriate`.
That startup failure is tracked in Beads `prefaix-mbd.10.4`; the investigation
below records its native reproduction and resolution. The readiness corrections
are `.10.2` and `.10.3`. The follow-up sweeps detected the
test-input edits and invalidated themselves, retaining all logs. Neither counts
toward final stability. The final passing sweeps below use fresh, frozen inputs.

Real pi child-tree RSS and laptop energy consumption remain unmeasured. These
fixes bound worker ownership and replay count; they do not establish a battery
percentage or a total-process-tree memory budget. Linux CI and the human release
requirements remain pending.

## Fish PTY startup investigation and final stability (2026-10-01 UTC)

The fish startup symptom was reproduced in node-pty 1.1.0's native Darwin launch
path without fish, Prefaix, or xterm. A small C child checked `tcgetpgrp(0)`, its
own process group/session, and opening `/dev/tty`. One of 1,000 bounded launches
on Node 22.19.0 returned `tcgetpgrp = -1` with `ENOTTY` and `/dev/tty` failed with
`ENXIO`, while the process was its own session and process-group leader. A
Node 26.7.0 sample reproduced the same condition in one of 100 launches. This
isolates the failure below shell initialization and terminal-query handling;
the exact kernel interleaving remains unproven.

The native dependency also leaked PTY resources. New regression tests fail
against 1.1.0: 100 successful launches leave 200 PTY-related descriptors open,
and three native `E2BIG` spawn failures leave nine more. Longer standalone churn
eventually fails with `posix_spawnp failed`. The host's `kern.tty.ptmx_max` is
511. [Upstream issue 950](https://github.com/microsoft/node-pty/issues/950)
describes the Darwin descriptor-cleanup defects. These observations establish
the leak and startup failure independently; they do not prove the leak alone
caused the retained fish failure.

The development dependency is now pinned to `node-pty@1.2.0-beta.15`, whose
native Darwin implementation closes the parent slave and temporary master
descriptors. Both new regressions pass with no descriptor growth, and 1,000
standalone native launches each on Node 24.21.0 and Node 26.7.0 pass without a
missing controlling terminal. Full native E2E matrices pass 122 tests each,
including the new startup/failed-spawn regressions, all shell plugins, and exact
tty restoration. The beta is an explicit test dependency pin; Linux verification
still belongs to the outstanding CI gate. No startup retry, failure exclusion,
job-control change, or timeout increase was added.

Both fresh 50-repeat sweeps pass the original <1% gate:

| Matrix | UTC start / finish | Repeats | Tests | Failures |
|---|---|---|---|---|
| Node 22.19.0 / bash 4.4 / fish 3.6.4 | 00:35:06 / 00:46:20 | 50/50 | 3,550 | 0 |
| Node 24.21.0 / bash 5.2 / fish 4.0.2 | 00:35:06 / 00:42:47 | 50/50 | 3,550 | 0 |

Both include zsh 5.9 and macOS bash 3.2 fallback, with four workers per matrix.
Every one of the 100 unique repeat logs reports exactly 71 passing tests.
Both reports record artifact digest
`4a9434ed1e487887744f59cea64205b920b5e85f3b0f1aec3e44022ad205a96f`
and source/test/dependency digest
`f6d1f5e3145659cd6546f66e093764d0bf15d6a53a5b3fe47191359ae8693478`.
The manifest and lockfile are now included in the sweep fingerprint so a native
dependency change invalidates its evidence. Logs and reports are in
`build/flake-pty-final-{low,high}`; native probes, before/after regression logs,
full E2E, check, and coverage evidence are in `build/pty-startup-investigation`.
Earlier failed and invalidated attempts remain untouched and separate.

Fresh full check passes 1,672 tests with 10 expected broken-contract failures
and 10 optional skips. Coverage is 97.88/95.86/96.03/98.19 percent for
statements/branches/functions/lines. Beads `.10.2`, `.10.3`, and `.10.4` now
meet their local acceptance criteria; the parent `.10` still needs Linux CI
and required checks on `main`. Git publication and CI acceptance are recorded
separately in Beads.

## CI synchronization and keyboard capabilities (2026-10-01)

The first pushed native fix passed local stability, but remote CI exposed
independent test failures tracked in Beads `.10.5`, `.10.6`, and `.10.7`.
The existing shell-install step now precedes unit validation. Syntax checks
read regular temporary script files: fish 3.6.4 reproduces the stdin-socket
failure locally, and its `-n -c` form can return success for malformed source.
All three shells must accept the generated plugin and reject an appended
unclosed quote. This verifies the validation path as well as positive syntax.

The architecture suite loads its actual ESLint configuration in `beforeAll`,
so lazy TypeScript parser/rule initialization does not consume the first
boundary assertion's timeout. All forbidden and allowed imports, plus the
real CLI rejection, remain checked; no timeout was increased.

The PTY harness previously replied `CSI ? 0 u` to Kitty keyboard queries while
sending legacy key bytes. That reply advertises protocol support, rather than
declining it, under the
[Kitty specification](https://sw.kovidgoyal.net/kitty/keyboard-protocol/#detection-of-support-for-this-protocol).
Fish 4.9.3 reproduced the restored-buffer Ctrl+C failure before correction;
omitting the unsupported protocol reply passes the same buffer/typeahead
tests. Production shell code and job control are unchanged.

The vi test's fixed 100ms pause also reproduces the missing second client call
with fish 3.6.4 configured for a 500ms Escape delay. It now observes the actual
`fish_bind_mode` transition through a test-only event marker before pressing
Enter. The same deliberately slow-delay regression passes on fish 3.6.4,
4.0.2, and 4.9.3, without retries or a longer assertion timeout.

A fresh high-version sweep then exposed a separate restored-typeahead race
in run 13. The client had already cleaned up and written directives, but the
fish buffer's repaint preceded reliable processing of the next Ctrl+C.
The test now appends a real `X` keystroke and observes its rendered edit before
cancelling the buffer. It checks that neither the original nor edited command
created a file, both before cancellation and after ordinary-command recovery.
This observes editor readiness without executing a probe or sleeping longer.
The rejected/invalidated attempts remain in `build/flake-ci-goal-{low,high}`;
their results are not final passing stability evidence.

A subsequent frozen CI run at `3e780b5` exposed the same readiness gap in the
fixture's restored-directive cancellation test. Ubuntu older shells failed
run 41 and macOS older shells failed run 13, each one of 50 repeats; both
newer-shell gates passed 50/50. The test had sent Ctrl+C as soon as the
restored text was painted. It now observes an actual `X` insertion at the
restored zero cursor before cancellation, then checks that the command never
created its file, including after ordinary-command recovery. The full failed
reports and all repeat logs remain in `build/ci-goal-final-remote-stability`.
The 64 focused local before-correction probes did not reproduce the CI race;
they remain in `build/ci-goal-restored-directive-before`. This further test
change requires new frozen local and remote sweeps for final acceptance.

Before/after logs remain under `build/pty-startup-investigation/ci-goal-*`.
Full check passes 1,675 tests with 10 expected broken-contract failures and
10 optional skips. Coverage statements/branches/functions/lines is
97.83/95.83/95.93/98.15 percent.
Complete E2E passes 122 tests with seven optional iTerm skips on each native
configuration: Node 22.19.0/bash 4.4/fish 3.6.4, Node 24.21.0/bash 5.2/fish
4.0.2, and Node 26.7.0/Homebrew bash/fish 4.9.3. All include zsh and the
macOS bash 3.2 fallback. Fresh local/remote stability results and exact commit
acceptance are recorded in Beads and the
[CI investigation record](https://plan.ref.tools/7aNGRE2iAOaOLCzW).

## CI startup follow-up (2026-10-01)

The corrected restored-directive fixture passed both local 50-repeat matrices
and all four serial remote matrices on `415a735`. All 300 distinct logs were
audited: 71 tests per local/macOS repeat and 70 per Ubuntu repeat, where the
macOS native-bash fallback is not applicable. Reports retain artifact digest
`4a9434ed1e487887744f59cea64205b920b5e85f3b0f1aec3e44022ad205a96f`
and source/test/dependency digest
`f06968a631a2b41aa75c4f9a35018db889d507876704e9fbd352aeee09f43cfc`.
Remote summaries and every log are in
`build/ci-goal-directive-final-remote-stability`; both local reports are in
`build/flake-ci-goal-directive-final-{low,high}`.

[CI run 36811226560](https://github.com/MiraiForge/prefaix/actions/runs/36811226560)
passed all six unit/E2E/coverage stages, but macOS Node 26 failed only the
unchanged client-hello median budget: 61.74 ms against 60 ms. Its first-token
median was 99.90 ms against 100 ms. This uses the same production artifact as
the preceding passing performance run, so it establishes limited margin on a
variable runner rather than a source regression. The independent Node/socket
floor on that worker was 56.62 ms. The full failed report remains in
`build/ci-goal-directive-final-check-artifacts`.

The follow-up routes client turns through a small dispatcher and loads the
picker and asynchronous filesystem helpers only when requested or writing
results. Config validation and command classification still precede the daemon
connection. Doctor, injected terminal/I/O, handshake, turn rendering, and
directive behavior are preserved. The packaged-import regression fails on
the original code and verifies deferred filesystem loading on the correction.
Full check passes 1,676 tests, with 10 expected broken-contract failures and
10 optional skips. Coverage statements/branches/functions/lines is
97.74/95.65/95.84/98.07 percent. Each of the three complete local E2E
configurations passes 123 tests with seven optional iTerm skips.

Isolated Node 26 comparisons retain every 50-sample report. The first control
and candidate hello/first-token medians are 38.01/72.49 and 36.23/69.07 ms;
a consecutive control/candidate comparison records 37.36/71.16 and
36.30/69.83 ms. Single-bundle, independent-client-bundle, renderer-overlap, and
picker/clipboard-only experiments did not give useful median improvement and
were rejected. Reports and regression logs remain in
`build/pty-startup-investigation/startup-experiments`.
The timing definitions, budgets, sample count, and approved Node 26 RSS-only
exception are unchanged. Fresh exact-head checks and frozen local/remote
stability evidence are required for this changed production artifact; their
acceptance is recorded in Beads and the CI investigation record above.

The first startup correction (`a54472c`) passed both new local 50-repeat
matrices, with all 100 logs audited. CI passed five complete checks, including
macOS Node 26 at 38.04 ms hello and 63.38 ms first-token medians, but macOS
Node 24 failed at 63.14 and 100.19 ms. Its independent Node/socket floor was
55.83 ms; memory and throughput passed. These reports are retained in
`build/ci-goal-startup-final-check-artifacts`, and local stability reports in
`build/flake-ci-goal-startup-final-{low,high}` retain artifact `15ee38d7`
and suite `d8cf4d60` (full digests in their summaries).

The next follow-up enables Node's optional
[module compile cache](https://nodejs.org/api/module.html#module-compile-cache)
for actual client processes before importing the client chunks. It honors
Node's cache-directory and disable settings, and a blocked cache remains
nonfatal. Other commands and Bun do not enable this optimization. Imported
source modules used by the coverage suite also do not enable it.
The existing one-process warmup primes compilation; all 50 subsequent fresh
processes retain their complete spawn-to-hello and first-output timings.
No process is reused, no samples are dropped, and budgets are unchanged.

The isolated Node 26 experiment improves hello median from 36.30 to 32.07 ms.
Real packaged-process tests prove cache creation, explicit disabling, and a
non-directory cache path with successful local turns and exact directives.
The cache-creation case fails on the preceding code; enabled, disabled, and
blocked cases all pass with the correction. Experiment reports and logs remain
in `build/pty-startup-investigation/startup-experiments/compile-cache-*`.
This additional source/test change requires new frozen stability evidence;
partial remote runs on the preceding head are retained as superseded evidence.

With the compile-cache correction, full check passes 1,676 tests and coverage
statements/branches/functions/lines is 97.71/95.54/95.94/98.05%. All three full
local E2E configurations pass 126 tests each, with seven optional iTerm skips.
An earlier concurrently launched Node 22 E2E process exited with SIGTERM before
reporting results; its log is retained separately and its cause is unproven.
The subsequent sequential Node 22 run completed successfully. Unchanged
50-sample performance checks pass on Node 22/24/26, with hello medians
32.15/34.68/35.40 ms and first-token medians 66.00/68.85/69.63 ms. These are
local measurements; final CI and new frozen sweeps must establish acceptance.

At `b2e8c31`, all five completed CI performance jobs pass the original budgets;
macOS Node 24 reports hello/token medians 42.04/71.34 ms. Both local stability
matrices pass 50/50 with all 100 logs audited (artifact `3c0934d3`, suite
`ca81e459`). Ordinary Ubuntu Node 22 E2E instead fails fish 3.7.0's raw-prompt
history assertion: Up recalls the preceding ordinary command. Its completed
job log is `build/pty-startup-investigation/ci-goal-cache-final-110225894274.log`.
This rejected head's passing and interrupted remote reports remain separate.

Fifty isolated diagnostic attempts each on fish 3.6.4 and 3.7.0 do not reproduce
that failure; its precise cause remains unproven. The history test now observes
a unique editor marker's insertion and deletion before sending Up, strengthening its
input-readiness precondition beyond prompt painting. The expected recalled raw
prompt and all subsequent history/identity assertions are unchanged. Missing
history remains a failure. This test change requires new exact-head CI and
frozen local and remote stability sweeps; earlier passing sweeps do not replace
them.

The preserved `c8f41ec` Ubuntu older-shell repeat 4 still fails this recall
assertion after the editor marker, proving that input readiness alone does not
resolve the defect. Its rejected log remains in
`build/ci-goal-history-final-complete-artifacts/stability-ubuntu-latest-bash4.4-fish3.6.4/run-4.log`.
Fish 3.x only refreshes its history mapping when its own clock advances beyond
the merge boundary. A clock-skew fixture that advances external `date` first
fails three isolated recall attempts with the elapsed-time check, and passes
all three with the history-state barrier. The permanent regression also fails
before the correction and passes on fish 3.6.4, 3.7.0 and 4.0.2 afterward,
recalling and resubmitting a literal multiline prompt with its trailing newline.
These probes establish the synchronization defect; they do not prove the exact
clock interleaving in the archived CI failure. All before/after logs remain in
`build/pty-startup-investigation/history-*-before.log` and
`build/pty-startup-investigation/history-*-regression-*.log`.

At `3f9eb09`, all six functional and all six versioned performance CI jobs
pass, and both frozen local sweeps pass 50/50. The macOS newer-shell job fails
before tests because all four connections to `ftp.gnu.org` time out. Bash
sources now use the kernel.org mirror with the GNU origin as a transport
fallback. Both supported archives retain their original SHA256 pins; checksum
mismatch fails before extraction and does not fall back. The rejected job log
is `build/pty-startup-investigation/ci-goal-benchmark-final-110237302616.log`.
New production/test inputs require fresh complete CI and frozen sweeps.

The initial single-character marker was rejected on all three local matrices:
fish displayed an `x264` autosuggestion after `X`, so the exact screen barrier
correctly failed. Those full-suite logs remain in
`build/pty-startup-investigation/ci-goal-history-e2e-*.log`; the final marker has
no completion or history match in the isolated shell session.

At `c8f41ec`, all six ordinary unit/E2E/coverage stages pass, and both fresh
local sweeps pass 50/50 with every 71-test log audited. Artifact `3c0934d3` is
unchanged; the corrected test fingerprint is `518ac49e` (full digests in
`build/flake-ci-goal-history-final-{low,high}/summary.json`). macOS Node 26
instead fails timing at 65.91/105.13 ms hello/token medians. Its independent
322-byte Node/socket probe measures 67.86 ms median, already above the hello
budget; compiled Bun's floor is 50.95 ms. The reports and completed job log
remain in `build/ci-goal-history-final-check-artifacts` and
`build/pty-startup-investigation/ci-goal-history-final-110231673703.log`.

CI now separates required performance jobs from the functional suites, using
versioned standard `ubuntu-24.04` and `macos-15` runners on Node 22/24/26.
[GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
identifies the standard macOS 15 runner as arm64 M1. The six functional jobs
and four shell-version matrices continue on the latest OS images. Every
performance job still enforces the original timing, throughput and memory
gates with all 50 samples and the existing RSS-only Node 26 exception. The
M3 aggregate also requires the performance matrix to succeed.

This fixes the benchmark OS labels and isolates their workload from the test
suites; it does not establish that macOS 26 caused the slow measurement, or
eliminate shared-host variability. Final exact-head CI and fresh frozen sweeps
must pass on this declared benchmark baseline before acceptance.

## Earlier local baseline (2026-09-30)

Before the restart and worker-lifecycle corrections, the validated artifact digest was
`dcab1931d283723d8426f2b0a974153db9efe5f6fd3ec57511199f256af4964a`.
The measurements below use an Apple M4 Max, arm64 macOS (Darwin 27.0.0).

| Check | Result |
|---|---|
| `bun run check` | Lint/typecheck pass; 1,591 tests pass, 10 expected broken-contract failures, 10 optional tests skipped |
| Coverage | 97.83% statements, 95.70% branches, 95.92% functions, 98.13% lines |
| Node 22.19.0, bash 4.4, fish 3.6.4 | 119 E2E tests pass; 7 optional iTerm tests skipped |
| Node 24.21.0, bash 5.2, fish 4.0.2 | 119 E2E tests pass; 7 optional iTerm tests skipped |
| Both native matrices | Include zsh 5.9, macOS bash 3.2 fallback, Unicode restoration, prompt/process counters, and bash login profiles |
| Clean npm tarball install | Version, all three init scripts, and a fake turn pass; package contains only manifest, README, LICENSE, and dist |
| Installed pi 0.87.1 | No-model RPC smoke passes |
| Workflow and docs | Actionlint, generated config reference, package privacy guard, and diff whitespace checks pass |
| Stability | 50/50 older-version and 50/50 newer-version repeats pass: 7,100 repeated tests, zero failed runs; four workers per matrix |

| Node | Hello p50 / p95 (ms) | First token p50 (ms) | Fresh / ordinary idle (MiB) | Burst deltas/s, slowest | Post-burst idle (MiB) |
|---|---|---|---|---|---|
| 22.19.0 | 27.54 / 29.62 | 50.91 | 45.33 / 46.31 | 26,882 | 48.56 |
| 24.21.0 | 30.42 / 32.80 | 53.79 | 50.19 / 53.69 | 25,367 | 54.31 |
| 26.7.0 | 31.07 / 32.59 | 54.31 | 55.98 / **59.50 (fails)** | 25,405 | **59.89 (fails)** |

Each runtime passed the timing and streaming throughput checks. The stricter
memory gate passes on Node 22 and 24 and fails on Node 26 after ordinary and burst use.
These are local macOS measurements; Linux results must come from the prepared
CI jobs. CI preserves performance JSON and stability logs as downloadable artifacts.

The [S8 startup comparison](spikes/S8-client-startup.md) records 50 fresh-process
samples per Node version and a compiled Bun stub. It measures the loader/socket
floor separately from the full production client. Its raw macOS results are
checked in; the same probe is prepared for every CI runtime/OS pair. Linux
comparison evidence remains pending.

The initial stability attempt found a test that sent Ctrl+C before a classifier
had exited. A delayed-exit regression exposed zsh's incomplete diagnostic
redraw as well. The test now waits for the restored buffer, and zsh invalidates
and redraws its prompt around classifier diagnostics. Both complete matrices,
the full check, coverage, package installation, and timing gates passed again
before restarting stability with four workers per matrix. The failed attempt
is retained separately and does not count toward the final result.

A second attempt exposed input echo leaking into a harness variable read. The
harness now brackets probe output with printed markers, and narrow-screen
multiline cases verify the boundary on all three shells. Actual colon scenarios
still use direct keystrokes, so the probe wrapper cannot bypass interception.

A later flow-control validation attempt hit native shell-spawn and controlling-
terminal failures. Separately, deterministic regressions proved that teardown
returned while zsh, fish, and bash processes ignoring SIGHUP were still alive.
The harness now awaits the exit notification before disposing the terminal or
removing HOME, with bounded SIGKILL escalation. All three regressions and both
complete matrices pass. The earlier failed sweeps remain in
`build/flake-flow-low-before-reap` and `build/flake-flow-high-before-reap`; they
do not count toward passing stability evidence.

Native bash 5.2 on Darwin 27 can print `child setpgid: Operation not permitted`
after a raw-mode child exits from `bind -x`. This was reproduced with a small
Node child in a clean bash with no Prefaix code. The tty tests capture `stty -g`
stdout separately, assert its exit status and exact settings, and then verify
Ctrl+C stops an ordinary foreground process. Any native warning remains in the
test log. This distinguishes the warning from terminal corruption without
disabling job control or suppressing shell stderr. Linux behavior still needs
CI evidence.

The final low-version sweep ran from 06:10:37 to 06:21:30 UTC, and the
high-version sweep from 06:10:37 to 06:17:53 UTC on 2026-09-30. Both recorded
the artifact above and source/test digest
`abce1c63fc63c48eeda7b94c172671a2d3f620ebd19d15da9d4065b6673de117`.
Every repeat contains 71 passing tests. Reports and individual logs are in
`build/flake-flow-low` and `build/flake-flow-high`. Five high-version repeats
logged the native Bash warning while exact tty restoration and foreground
recovery assertions passed. Earlier failed and interrupted attempts remain
separate and do not count toward this result. Final performance, package,
check, coverage, and regression logs are in `build/m3-validation`.

## Evidence that automation cannot replace

The roadmap separately requires Allan's README-only fresh-machine walkthrough,
a clean doctor result in the daily-driver shell after removing Forge, and three
days of normal use on at least two shells without tty corruption or lost
text. Record the actual dates, shells, terminal, and outcome in Beads. Do not
backfill these from tests or elapsed agent runtime.
