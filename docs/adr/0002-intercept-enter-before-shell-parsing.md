# ADR 0002: Intercept Enter before the shell parses prompts

Date: 2026-09-24

Status: Proposed in design v0.1; shell and terminal mechanics await spikes S4–S7.

## Context

The user should type `: explain $(pwd) and don't expand *.ts` as ordinary text.
Shell parsing would expand the substitution and glob, and treat the apostrophe as
syntax. The integration must receive the original buffer while preserving normal
commands, shell history, multiline input, and existing prompt integrations.

## Decision

Implement [D3](../DESIGN.md#2-decisions-at-a-glance) with an Enter interceptor in
each supported line editor: a zsh ZLE widget, fish Enter bindings, and a bash
Readline macro combining `bind -x` dispatch with a dynamically rebound second key.

Inspect the first line with a cheap shell-builtin prefix test. Normal commands
delegate to the shell's usual accept action without starting a process; preserve
wrapped widgets used by other plugins. A matching line goes to `prefaix run` as
one raw argv element. TypeScript owns the authoritative grammar, keeping command
interpretation consistent across shells.

Preserve builtin idioms such as bare `:`, `: >file`, and `: ${X:=1}`, plus the
leading-space and backslash escape hatches. Add intercepted input to history
exactly as typed. After a run, refresh the shell prompt; when directives supply a
suggestion or typeahead, restore the buffer and cursor without executing it.

## Alternatives

- **Define a `:` function:** the shell parses and expands its arguments before the
  function can see them, so natural-language input still needs shell quoting.
- **Use preexec or command-not-found hooks:** they run too late to capture input
  before parsing, and malformed quotes may prevent dispatch altogether.
- **Require a quoted CLI invocation:** useful as a compatibility fallback, but
  does not provide the intended unquoted `:` interaction at the normal prompt.

## Consequences

Raw prompts can preserve apostrophes, substitutions, globs, and history-expansion
characters. The tradeoff is shell-specific keymap, history, repaint, and terminal
handoff code. Enter bindings must coexist with vi modes and other plugins; Forge's
Enter interceptor is a conflict requiring migration guidance.

bash 4.4+ is the proposed interception floor. macOS bash 3.2 instead gets `pfx`:
arguments use normal shell quoting, while the no-argument form reads a prompt.
[DESIGN §4.1](../DESIGN.md#41-shell-plugins) specifies the shell contracts.
[Spikes S4–S7](../ROADMAP.md#m1--spikes-45-d) must confirm binding, refresh,
history, and raw-terminal behavior. The shared PTY suite must verify byte-exact
prompts, builtin passthrough, normal commands, vi mode, typeahead, and tty recovery.
