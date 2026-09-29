# Spike S9 — pi bridge extension (`before_agent_start` section + `setActiveTools`)

**Status: load path verified, patch path not.** Everything reachable without
sending a model request is recorded below; the two assertions that need a turn
are listed at the end and are blocked on an allowed provider, not on effort.

- pi 0.87.1, macOS, spawned as `pi --mode rpc --offline --session-id … -e dist/pi-bridge.js`
- Verified by running it, on 2026-09-29
- Extension source: `src/agents/pi/bridge.ts`, bundled by tsup to `dist/pi-bridge.js`

## The question

Can a `-e` extension make pi take per-turn shell context as a **system-prompt
section**, so the visible user message stays byte-for-byte what the user typed
(D9, ADR 0004), and switch tools for a persona without a respawn?

## The API, read from pi's own declarations

`BeforeAgentStartEvent` is the hook (from
`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`):

```ts
interface BeforeAgentStartEvent {
    type: "before_agent_start";
    prompt: string;                                   // the visible user text
    systemPromptOptions: NormalizedBuildSystemPromptOptions;  // mutable
}
```

`NormalizedBuildSystemPromptOptions` carries `sections: Record<string, string>`
(`dist/core/system-prompt.d.ts`). pi's own doc comment on that field is the
answer to the whole design question:

> Ordered system prompt sections, keyed by name. … every other section is
> wrapped in a tag of the same name so the model can match later updates to it.
> These become `SystemMessage.sections` in the transcript.

So `event.systemPromptOptions.sections.prefaix = "…"` is a first-class,
diffable prompt section recorded in the transcript, and `event.prompt` is
untouched. `pi.setActiveTools(names)` and `pi.getActiveTools()` are on
`ExtensionAPI`, with the binding to the runtime deferred until after load
("During initial extension load this call is queued").

## Verified: the extension loads in RPC mode

Spawned with `-e <bundle>` and the turns directory in `PREFAIX_BRIDGE_DIR`:

| Check | Result |
|---|---|
| Extension loaded at all | **Yes.** The extension wrote `<turns>/<pi-pid>.ready` before `get_state` answered. |
| Without `-e` | No ready file. The absence is therefore a real signal, not an artifact of the directory. |
| `get_state` still answers | Yes, unchanged. |
| Pre-ready `extension_ui_request` | Confirmed again: pi-lens pushed `setWidget` and `setStatus` records **before** the first reply. M2-4's pre-ready buffering is load-bearing. |
| stdin EOF | Exit 0. |

This is the whole basis of the capability probe: pi finishes loading
extensions before it answers its first command, so by the time
`PiSession.ready()` resolves the ready file is either there or never going to be.
No polling window is needed, and a spawn whose bridge failed to load falls
straight through to the prepend fallback.

## Not verified, and why

`before_agent_start` fires at the start of the agent loop, so both remaining
assertions need a model request. `PREFAIX_LIVE_PROVIDER` and
`PREFAIX_LIVE_MODEL` are not set, and DESIGN §12.4 plus `AGENTS.md` forbid
sending anything without them.

- The `prefaix` section appears in the transcript's system message, as a
  **delta** rather than a replacement.
- `pi.setActiveTools()` from inside the handler actually changes the tool set
  the model is offered, and `getActiveTools()` returns it afterwards.
- The visible user message is unchanged in the session JSONL.

To finish:

```sh
export PREFAIX_LIVE_PROVIDER=google
export PREFAIX_LIVE_MODEL=google/<an-allowed-model>
bun run test:contract -- pi-live
```

`test/contract/live.test.ts` is the opt-in gate, and it now exists. It spawns a
real pi through `PiAdapter` with the bridge configured, prompts once, and
asserts on `<turns>/<pid>.applied.log`, which records the `prompt` pi saw
alongside whether a section was patched. The log is the artifact the acceptance
criterion ("the section appears in the transcript and the user message is
untouched") actually needs, and it is written by the extension itself rather
than inferred. It skips unless both variables name an allowed pair, and it has
not been run: tracked as `prefaix-0e6`.

## Decision

**D9 holds as designed.** The extension API supports exactly what the design
assumed, so the section path is the default and prepending stays the fallback.

Two refinements came out of this spike and are in the implementation:

- **The probe is a file, not a timeout.** pi answers its first command only
  after extensions load, so "did the bridge load" is answered by the ready
  file's existence at that moment. A timer would have been a guess.
- **The persona tool set is captured at load.** `setActiveTools` is queued
  during load and applied after binding, so `getActiveTools()` inside the
  factory is not the runtime truth. The bridge records pi's own tool set when
  it loads and restores exactly that when a persona is dropped, rather than
  restoring the queued value or guessing a default.

## Consequences

- `pi-bridge.js` ships inside the package and is loaded only through `-e`; the
  user's pi configuration is never touched.
- Context files are named `<turns>/<pi-pid>.json`, removed by the extension as
  soon as it has read them, and written 0600 (DESIGN §10).
- A persona change now takes effect on the next turn rather than immediately,
  because the tool switch rides along with the turn's context. That is the
  first moment it is observable, and it costs no respawn.
- Compatibility with pi's extension API is a real dependency. `prefaix doctor`
  and the pre-ready buffering around a failed load are what keep a pi upgrade
  from becoming a broken turn.
