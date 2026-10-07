# S9: pi bridge, tool activation, and recorded extension UI

**Status: resolved, 2026-10-07.** D9 holds: use a separate system-prompt
section and change persona tools without respawning. Preserve prepend/spawn
fallbacks when the bridge is unavailable.

## Question and method

Can a bundled `-e` extension inject shell context without changing the visible
user prompt, restore the native tool loadout after a persona, and surface native
extension UI through RPC?

Earlier pi 0.87.1 evidence established loading and context/user-message behavior.
The completed probe now runs actual installed **pi 1.0.4** against an isolated
literal loopback HTTP/SSE API. Dummy credentials, guarded provider/model selection,
isolated HOME/profiles, disabled user resources/background activity, and base-URL
verification before prompts prevent a request to a real model endpoint.

`scripts/spikes/m1-native.ts` loads the production bridge and a trusted,
probe-only `rpc-ui.ts` extension. It inspects actual API tool schemas,
native transcripts, RPC order, and the adapter's normalized events. Replies,
tool choices, and usage are **scripted**, not natural Kimi output.

## Native results

[Complete native report](M1-native-pi1.0.4.json); original evidence is private
under `build/spikes/M1-native-final-20261007/`.

| Check | Observation |
|---|---|
| Context injection | `prefaix` section beside pi's sections, not a replacement |
| Visible user messages | Byte-for-byte unchanged |
| Read-only persona request | API offered only `read` |
| Dropping persona | API offered `bash, read`, the actual initial loadout |
| Subsequent ordinary/dialog turns | Same initial `bash, read` loadout |
| Child identity | Same PID through the context/tool switches |
| Native dialog | Select → notification → status → editor suggestion |
| Timing | UI requests **before prompt acknowledgment and agent_start** |
| Normalized adapter round trip | UI answered successfully; one final stop settlement |

The bridge portion made **five loopback requests**, including one independent
adapter verification turn; **zero remote model requests**. This does not claim
that Kimi naturally generated those answers/tools or that zero stub prices
measure coding-plan charges.

## Bugs found and corrected

1. **Tool baseline captured too early.** At extension load,
   `getActiveTools()` can be unbound/empty. Refresh the baseline at
   **session_start**, after runtime binding, and restore that loadout when
   dropping a persona. Restoring an empty queued value is wrong.
2. **Dialog before prompt acknowledgment.** Waiting for the acknowledgment
   before consuming events deadlocks a `before_agent_start` dialog.
   Consume concurrently, forward pre-start UI, race acknowledgment failure
   and abort, and cancel abandoned queue reads so a later turn is not swallowed.

The ready-file probe remains useful: after native readiness, the bundled bridge
has either signaled loading or the adapter must use its fallback.

## Reviewed replay evidence

`test/fixtures/pi/recorded/bridge.jsonl` retains native event order and
source `controlled`. It comes from raw `bridge.jsonl`, SHA-256
`68079c1613a0cd81c606dc61227e80eeed5c1520ff573e8144dfc35e6db4c4d3`,
half-open raw record range **[53, 70)** excluding the capture header.

Regenerate into a new directory:

```sh
bun scripts/spikes/rpc-curate.ts --s9 <passed-native-directory> <new-output-directory>
```

Curation retains UI payloads, normalized IDs, and the actual acknowledgment
boundary. Explicit replay holds require a **fresh matching answer on every
turn**; they are playback controls, not new native events. The recorded contract
target now uses this dialog, while built-in tool examples remain supplemental.

Tests cover two dialog turns, ignored stale responses, unanswered-dialog replay
abort, prompt rejection followed by success, tool-baseline restoration, and UI
editor suggestions that do not execute.

## Decision and evidence limits

Keep D9 and personas-without-respawn when the bridge probe succeeds. Context
files stay 0600 and are removed when read or when an abandoned turn ends.
The opt-in live contract now guards before spawn, pins **both provider and
model**, verifies native selection before prompting, and refuses conflicting
overrides. Scripted tests validate that selection without a paid request.

Successful **native** pre-ack UI is verified. Long-held human dialogs and
**native** unanswered preflight cancellation are separate hardening work:
an ordinary RPC deadline can expire during a dialog, and a replay's abort
behavior does not prove pi cancels its pending UI hook. Those gaps are tracked
in Beads; do not label synthetic/recorded cancellation as native evidence.
This spike does not authorize a release or a new paid recording.
