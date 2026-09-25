# ADR 0001: Keep agent processes warm in a daemon

Date: 2026-09-24

Status: Proposed in design v0.1; pool defaults and cwd behavior await spikes S2/S3.

## Context

Successive `:` prompts should continue a conversation without paying agent startup
cost each time. [DESIGN §2, D1](../DESIGN.md#2-decisions-at-a-glance) records pi RPC
startup at roughly 740–860 ms with five extensions, or 215 ms without extensions,
plus up to 500 ms for shutdown. These are the design's existing measurements on
Allan's machine, not a cross-platform benchmark. The target for a warm turn is
less than 100 ms of prefaix overhead, excluding provider latency.

## Decision

Run one auto-spawned, headless daemon per user. It owns a pool of agent child
processes and relays normalized events over a local Unix socket. A short-lived
foreground client owns the terminal and renders each turn. The pi adapter uses
the user's installed `pi --mode rpc` behind the backend-independent `AgentPort`.

Bind each active child to a conversation, workspace root, and environment
fingerprint. An environment change respawns the child on the same native session.
Persist the conversation index and native transcript independently of the pool;
the shell retains its non-exported conversation ID across daemon restarts. The
pool uses idle eviction and an optional warm spare; the daemon exits when idle.

## Alternatives

- **Spawn `pi -p` for every prompt:** simpler lifecycle, but repeats startup and
  shutdown costs even when continuing the same conversation.
- **Persistent PTY wrapper:** keeps the agent warm, but makes a wrapper responsible
  for the shell and terminal lifecycle instead of returning to the existing prompt.
- **In-process pi SDK:** avoids RPC transport, but loses child-process crash
  isolation and couples the daemon to its own pi dependency rather than the user's
  installation. This is the related D2 boundary.

## Consequences

Warm turns reuse agent state, while the foreground client remains responsible for
terminal cleanup. The cost is persistent memory and explicit socket permissions,
startup locking, protocol/version negotiation, child eviction, and crash recovery.
Use a 0600 socket inside a 0700 runtime directory. A failed child ends its turn with
an error; the next turn can resume its persisted session in a replacement child.

[DESIGN §4.3](../DESIGN.md#43-daemon-prefaix-daemon) defines the lifecycle.
[Spikes S2/S3](../ROADMAP.md#m1--spikes-45-d) must validate pool memory/spare
adoption and session resumption from another cwd before fixing those defaults.
Later integration tests must cover concurrency, busy rejection, disconnect abort,
environment-change respawn, idle exit, and stale-lock recovery.
