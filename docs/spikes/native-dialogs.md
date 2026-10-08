# Native pi dialogs: deadlines and safe cancellation

**Resolved on pi 1.0.4, 2026-10-08.** This is follow-up hardening to
[S9](S9-pi-bridge-extension.md), not a claim that recorded cancellation was
already native proof. [Public provenance and results](native-dialogs-pi1.0.4.json)
retain hashes of the source and private raw artifacts.

## Reproduction and scope

`scripts/spikes/dialogs-native.ts` runs the production PiAdapter, bridge, and
AgentPool against actual installed pi, with an isolated HOME/profile, dummy
credentials, explicit guarded provider/model selection, and a literal loopback
HTTP/SSE endpoint. The selected model and its actual native base URL are
checked before every prompt, including the timeout attempt. User resources, MCP, background activity, retry, and compaction
are disabled. All answers/usage are scripted: **zero remote model requests**.
The recorder parent is Bun 1.4.2 (its Node compatibility version is v26.3.0);
that is not a claim about the native child's Node version or the CI toolchain.

```sh
PREFAIX_LIVE_PROVIDER=kimi-coding \
PREFAIX_LIVE_MODEL=kimi-coding/k3 \
bun run spike:dialogs-native -- build/spikes/dialogs-native-new
```

Before the fix, a 1,500ms human wait with a 500ms transport deadline produced
`settled(error): pi prompt timed out after 500ms`, even though pi was still
waiting for its preflight dialog. Answering that question could release native
work after the local failure. The failing run is retained separately under
`build/spikes/dialogs-native-before-clean/` and its sibling log; failed and
invalid recorder attempts are not passing evidence.

## Decision

- Pause **prompt-acceptance** deadlines while supported `select`, `confirm`,
  `input`, or `editor` dialogs are unanswered. The ordinary deadline restarts
  after the last answer/extension-owned timeout. Readiness and metadata still
  have their own deadlines; notifications and unknown methods do not pause them.
- Ignore duplicate, unknown, and expired answers. Retire auto-resolved pre-ack
  dialogs at acceptance without losing later tool UI. Map buffered startup UI
  only once and never submit a prompt after its startup dialog was aborted.
  Startup delivery is covered by scripted transport tests, not a new native
  blocking-startup-dialog proof.
- **Abort an unanswered dialog by terminating the owned child**, not by merely
  returning locally or answering `cancelled`. In pi 1.0.4, RPC `abort` does not
  clear pending extension UI promises, and a cancellation answer can continue
  preflight rather than cancel the turn. The pool replaces that unusable child
  and resumes the saved native conversation. This trades warm reuse for a
  proven stop; it does not assert graceful native hook cancellation.
- A genuinely timed-out, unacknowledged prompt also terminates its child, so
  delayed preflight cannot start a model after local error settlement. Preserve
  the deadline error rather than racing it against the synthesized kill error.
  Cancel shutdown timers once an exit is observed.

Ordinary turns without an unanswered dialog retain `clear_queue` → `abort` and
queued-text restoration. The restrictions remain entirely in the pi adapter;
the headless daemon and renderer receive backend-independent events.

## Controlled native results

Every human question was held about 1,500ms, three times the 500ms acceptance
budget. No acknowledgment, `agent_start`, or API request appeared while it was
held.

| Turn | Result | Local API requests | Child |
|---|---|---|---|
| Answer held dialog | One `settled(stop)` | 1 | A, warm |
| Abort unanswered dialog by signal | One `settled(aborted)` | 0 | A exits |
| Recover conversation | One `settled(stop)` | 1 | B, same native file/session |
| Abort unanswered dialog by method | One `settled(aborted)` | 0 | B exits |
| Recover again | One `settled(stop)` | 1 | C, same native file/session |
| Silent 2,000ms preflight | One deadline `settled(error)` | 0 | C exits at deadline |
| Recover after timeout | One `settled(stop)` | 1 | D, same native file/session |

The probe checks actual child disappearance (`kill(pid, 0)` returns ESRCH), not
just the adapter's usability flag. It waits beyond the silent preflight's
original continuation time and checks for zero late requests. Native transcripts
retain exactly the four successful visible user messages and no aborted or
timed-out user messages. RPC state confirms the native session ID after every
replacement.

Raw RPC, lifecycle traces, API request bodies, native transcript, and summary
are retained privately under `build/spikes/dialogs-native-guarded-final/`. The public
report uses child labels instead of local PIDs/paths. Eighteen scripted deadline
and lifecycle regressions plus six cost-guard refusal cases run normally, with
no native pi/model invocation in the test suite.

These results establish this controlled adapter/toolchain behavior, not natural
model output, arbitrary extension/background-process containment, every pi
version, or the M3 human/release gates. Killing pi cannot sandbox processes an
extension separately detached. Package publication remains unauthorized.
