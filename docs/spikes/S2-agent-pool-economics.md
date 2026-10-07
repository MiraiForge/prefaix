# S2: agent pool economics

**Status: resolved, 2026-10-07.** Retain a six-child capacity ceiling and the
optional one-spare policy. Do **not** force `--offline` by default.

## Question and method

How much readiness latency does a spare save, what does each pi child cost in
memory, and does offline startup justify changing the user's pi behavior?

`bun run spike:m1-native -- <new-directory> 20` starts actual installed pi
**1.0.4** on Linux x64 with isolated profiles and a dummy credential. Each of
20 rounds alternates the order of these fresh-process variants:

- **offline:** no user resources/extensions and `--offline`;
- **metadata-online:** the same profile without `--offline` or `PI_OFFLINE`;
- **bridge:** offline plus the bundled bridge and a trusted probe UI extension.

Readiness is the first successful `get_state`; RSS is OS `ps` resident size
at readiness. The file cache is not flushed. These are fresh processes, not
cold machines. The extension variant is **not** a measurement of the user's
full extension collection. Metadata-online may refresh non-model metadata;
it is not an air-gap claim.

A separate child receives title/model/thinking settings, then one scripted
loopback turn. Its PID, session ID, and session file must remain unchanged.
RSS is measured before and after that turn. Every prompt first verifies the
selected provider/model and literal loopback base URL.

## Results

Raw sample values and observations: [native report](M1-native-pi1.0.4.json).
Original stdout, traces, stderr, and transcripts remain private in
`build/spikes/M1-native-final-20261007/`. Quantiles below use nearest-rank
order statistics; each startup row contains 20 samples.

| Variant | Ready p50 / p95, ms | Idle RSS p50 / p95, MiB |
|---|---|---|
| Offline | 168.44 / 174.43 | 111.23 / 111.73 |
| Metadata-online | 179.60 / 190.50 | 113.62 / 114.72 |
| Bridge + probe UI | 177.29 / 183.40 | 111.46 / 112.34 |

Spare adoption preserved the same PID, ID, and file after the first turn.
Idle RSS was **115,662,848 bytes (110.30 MiB)**; after the turn it was
**119,173,120 bytes (113.65 MiB)**. The turn had one native settlement.

These are **controlled-native** observations: actual pi lifecycle/tool behavior,
scripted HTTP/SSE answers and usage, and **zero remote model requests**. They
are not measurements of Kimi's natural latency, limits, or coding-plan charges.
The runner is Bun; its report's `driver` field is Bun's Node-compatible
`process.version`, not a claim that pi was launched under that Node release.
Earlier pi 0.87.1/macOS/user-extension startup numbers are not directly comparable.

## Decision

- **Keep `pool.max_children = 6` as a ceiling, not a reservation.** At this
  baseline, six children can consume roughly 670–690 MiB, in addition to the
  daemon. The spare counts against those six. Extension-heavy or constrained
  machines should lower the ceiling; these data do not promise an RSS bound.
- **Keep one optional spare enabled.** It can save roughly 0.17 seconds on a
  fresh conversation at a marginal baseline cost of about 110 MiB. It does not
  prompt a model. Existing transcripts and persona-bearing requests still open
  their own child; identity checks support adoption, not arbitrary reassignment.
  `pool.spare = false` remains the low-memory choice.
- **Keep offline opt-in.** The roughly 11 ms baseline p50 gain is too small to
  justify globally changing metadata/update behavior. Offline turns, tools,
  resume, and UI worked in the controlled cases, but that is not proof of
  compatibility with every user extension or metadata workflow.

The 60,000,000-byte daemon budget excludes agent children. Retain idle expiry
and capacity/LRU accounting; do not mistake the pool ceiling for a memory budget.
