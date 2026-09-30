# S8: client cold-start latency

**Question:** Does M3 need a compiled client to meet the daemon-hello startup
budget, or can it retain the bundled Node client?

**Decision:** Keep the bundled Node client for M3. On the M-series Mac, the full
client meets its p50 <60ms / p95 <120ms budget. A minimal compiled Bun client
saves at most 4.3ms at p50 over the equivalent Node stub and produces a 60.5MiB
executable. This does not justify a second distribution/runtime path locally.
The decision remains provisional until the prepared Linux CI comparison runs;
S8 stays open. This client experiment does not address the daemon's unresolved
Node 26 post-use memory overrun.

## Method

Run `bun run spike:client-startup` with Node 22.19 or newer and Bun 1.3.14.
`PREFAIX_STARTUP_NODE` selects the Node client executable,
`PREFAIX_STARTUP_BUN` selects the compiler, and `PREFAIX_STARTUP_REPORT` saves
the complete report. The script defaults to 50 samples and rejects fewer.

The same small TypeScript source is bundled for Node and compiled with
`bun build --compile`. Each fresh process connects to a local Unix socket,
prints the server's greeting, and exits. Hello time starts before spawning and
ends when the parent receives that greeting from the child; exit time also
includes process shutdown. This measures the loader/socket floor, not the full
production client or a model turn. One warmup per runtime is excluded, then
runtime order alternates across the 50 pairs. The OS file cache remains warm;
"cold" here means a new process, not a machine reboot or flushed disk cache.

Both clients use an isolated temporary HOME. Artifacts, socket, and HOME are
removed afterward. No model requests, real shell rc changes, or publishing
occur. The parent runs under Node so the two clients share the same native
Unix-socket server implementation. CI runs the comparison on macOS and Ubuntu
for Node 22, 24, and 26 and retains its JSON report.

## Local measurements: 2026-09-30

Apple M4 Max, arm64, Darwin 27.0.0; Bun 1.3.14. Values are milliseconds.
Each row has 50 recorded samples per variant; each raw report includes all
samples, versions, timestamps, sizes, and artifact hashes.

| Node | Node hello p50 / p95 | Compiled Bun hello p50 / p95 | Node exit p50 / p95 | Compiled Bun exit p50 / p95 |
|---|---|---|---|---|
| 22.19.0 | 20.94 / 22.11 | 20.86 / 21.61 | 22.86 / 24.22 | 22.14 / 23.21 |
| 24.21.0 | 24.06 / 25.75 | 20.84 / 21.58 | 25.81 / 27.46 | 22.15 / 22.96 |
| 26.7.0 | 25.06 / 26.90 | 20.79 / 21.47 | 26.81 / 28.66 | 22.08 / 22.79 |

The Node stub is 325 bytes and requires the installed Node runtime. The compiled
Bun stub is 63,446,114 bytes and includes its runtime. These are prototype
sizes, not production package sizes. Temporary build paths appear in generated
artifacts, so hashes identify each measured artifact rather than asserting
reproducible builds.

Raw reports: [Node 22](S8-client-startup-node22.json),
[Node 24](S8-client-startup-node24.json), and
[Node 26](S8-client-startup-node26.json).
The full client measurements and the distinct memory failure are in
[VALIDATION.md](../VALIDATION.md).

## Remaining evidence

The Linux CI jobs have not run because the local work has not been authorized
for commit/push. Record their reports and revisit the runtime decision if the
full client misses its budget. A compiled client would also need separate
packaging, daemon spawning, compatibility, and shell PTY validation before
shipping; this stub is not a production binary.
