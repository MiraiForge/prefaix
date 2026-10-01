# M3 validation

Beads epic `prefaix-mbd` owns the acceptance record. Passing local tests is not
proof of Linux CI, a three-day user trial, or publication.

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
boundary. The plugin persists the literal line before streaming and waits for
that boundary after a short turn before merging, so immediate ↑ recall works.
This can add up to about one second when returning to the prompt; fish 4.x does
not use this wait.

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
RSS blocker; M3-12 still needs Linux evidence. A diagnostic forced collection
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

Before/after logs remain under `build/pty-startup-investigation/ci-goal-*`.
Full check passes 1,675 tests with 10 expected broken-contract failures and
10 optional skips. Coverage statements/branches/functions/lines is
97.86/95.83/96.03/98.17 percent.
Complete E2E passes 122 tests with seven optional iTerm skips on each native
configuration: Node 22.19.0/bash 4.4/fish 3.6.4, Node 24.21.0/bash 5.2/fish
4.0.2, and Node 26.7.0/Homebrew bash/fish 4.9.3. All include zsh and the
macOS bash 3.2 fallback. Fresh local/remote stability results and exact commit
acceptance are recorded in Beads and the
[CI investigation record](https://plan.ref.tools/7aNGRE2iAOaOLCzW).

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
