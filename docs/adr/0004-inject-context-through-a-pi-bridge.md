# ADR 0004: Inject shell context through a pi bridge extension

Date: 2026-09-24

Status: Proposed in design v0.1; RPC-mode extension behavior awaits spike S9.

## Context

Every turn needs fresh shell context: cwd, recent commands, and the active
persona. Prepending it to each prompt would clutter pi's transcript and subsequent
TUI handoff. Switching between normal and read-only personas should also avoid
respawning a warm agent when the backend can change tools in place.

## Decision

Implement [D9](../DESIGN.md#2-decisions-at-a-glance) with a bundled `pi-bridge.js`
extension loaded explicitly through pi's `-e` option, without changing the user's
pi configuration. Before each prompt, the adapter writes shell context and
persona data to `$RUNTIME/turns/<childPid>.json`; writes are sequential per child.

On `before_agent_start`, the extension reads the file and patches a `prefaix`
system-prompt section. The intended result is a recorded section delta while the
visible user message stays exactly as typed. Persona changes patch a `persona`
section and call `pi.setActiveTools([...])`; `:ask` uses `read`, `grep`, `find`, and
`ls` with a guideline against modifications.

Probe extension capability when spawning the child. If loading/probing fails,
prepend a compact `<shell-context>` block to the user message and respawn persona
changes with `--tools`. Keep pi-specific extension behavior behind the adapter
and represent support through `AgentPort` capabilities.

## Alternatives

- **Always prepend context:** does not require an extension, but changes visible
  user messages; retain it as the compatibility fallback.
- **Respawn for each persona change:** applies the tool set through startup flags,
  but incurs cold-start latency; use it only when the bridge is unavailable.
- **Edit the user's pi configuration:** adds persistent installation state when
  loading the bundled extension explicitly can keep integration package-owned.

## Consequences

When supported, context stays separate from user text and persona changes reuse
the warm process. Compatibility now depends on pi's extension APIs, so clean
transcripts and persona switching without respawn remain unverified until
[S9](../ROADMAP.md#m1--spikes-45-d). The fallback keeps context and personas usable
at the cost of transcript noise and respawns.

Context files must be 0600 and deleted after `agent_start`; redact recent commands
before they leave the client. Environment secrets stay out of the prompt.
Read-only personas are a convenience, not a security boundary.
[DESIGN §4.5.4](../DESIGN.md#454-bridge-extension-pi-bridgejs-shipped-inside-the-package)
specifies the bridge. S9 must inspect RPC-mode session JSONL and active tools;
implementation also needs fallback tests and the live-model guard for live tests.
