# S8: client cold-start latency

**Question:** Does M3 need a compiled client to meet the daemon-hello startup
budget, or can it retain the bundled Node client?

**Status: resolved, 2026-10-07. Decision:** Keep the bundled Node client for
M3. The full client meets its p50 <60ms / p95 <120ms hello budget on both native
CI platforms. Compiled Bun saves 7–12ms at p50 on the virtual Mac, but is
**slower** by 3–6ms on Linux and adds a 60.5MiB/90.2MiB runtime artifact.
That does not justify a second distribution/runtime path. Node 26's distinct
daemon RSS overrun on macOS remains explicitly allowlisted by Allan, not fixed
by compiling the client.

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

## Native CI comparison: 2026-10-07

[CI run 37573150805](https://github.com/MiraiForge/prefaix/actions/runs/37573150805)
is green on attempt 2 at committed
`72d512bf1615d63ba0997c6c895a07725f551757`. The rerun recovered the macOS
Node 24 PTY job interrupted by runner shutdown/exit 143; previously successful
matrix jobs retain their original artifacts. This is **not** CI validation
of subsequent implementation changes.

Each runtime has 50 samples per variant, Bun 1.3.14, and one excluded warmup.
macOS uses an Apple M1 virtual runner; Ubuntu uses native x64 cloud CPUs.
CI load differs between jobs, so these are measured pairs, not a controlled
comparison of Node releases.

| Platform / Node | Node hello p50 / p95, ms | Compiled Bun hello p50 / p95, ms |
|---|---|---|
| macOS 15 / 22.23.2 | 57.10 / 80.77 | 49.62 / 68.70 |
| macOS 15 / 24.20.0 | 36.66 / 57.89 | 24.53 / 63.20 |
| macOS 15 / 26.10.0 | 33.62 / 42.98 | 21.91 / 40.03 |
| Ubuntu 24.04 / 22.23.3 | 27.85 / 32.21 | 30.65 / 40.04 |
| Ubuntu 24.04 / 24.21.0 | 19.97 / 23.53 | 22.78 / 26.92 |
| Ubuntu 24.04 / 26.10.0 | 26.98 / 29.26 | 33.01 / 38.61 |

The compiled stub is **63,446,114 bytes on macOS** and **94,582,912 bytes on
Linux**; Node stubs are 322/270 bytes plus the installed runtime. None is a
production compiled client.

[Reviewed raw reports and original-file SHA-256 manifest](CI-37573150805.json)
retain every sample and variant artifact hash for all six startup jobs and
six separate production performance jobs. Original downloads are under
`build/m3-validation/ci-37573150805/`. Production performance meets the
timing/throughput gates on all six OS/runtime entries; see the latest
[validation evidence](../VALIDATION.md#native-ci-evidence-2026-10-07).

A future compiled client still needs independent packaging, daemon spawning,
compatibility, and shell PTY validation. Revisit only if the full client misses
its budget; these stub timings do not authorize shipping a compiled binary.
