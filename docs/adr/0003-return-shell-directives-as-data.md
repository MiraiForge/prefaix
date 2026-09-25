# ADR 0003: Return shell directives as data

Date: 2026-09-24

Status: Proposed in design v0.1.

## Context

The foreground client cannot directly change its parent shell's conversation
variable or line-editor buffer. It must return state for the plugin to apply.
Some values, particularly future `:suggest` output, contain model-generated shell
commands. Treating these values as shell source would turn a suggestion into code
execution before the user reviews it.

## Decision

Implement [D7](../DESIGN.md#2-decisions-at-a-glance) as a NUL-delimited file of
`key\0value\0` pairs under `$RUNTIME/shells/<shellId>/directives`. The plugin passes
the path and a per-invocation nonce to the client, then ignores a missing file or
one whose `nonce` does not match. Only `conversation`, `status`, `buffer`, and
`cursor` are applied; unknown keys are ignored.

Read and apply the values using shell builtins. Assign buffer text to zsh's
`BUFFER`, bash's `READLINE_LINE`, or fish's `commandline -r`; never `eval` or
`source` the returned file. Restoring a suggestion or typeahead must redraw the
prompt without accepting the line. The user presses Enter to execute it.

NUL framing preserves spaces, quotes, backslashes, and newlines without inventing
a shell-escaping format. Embedded NUL bytes are outside this representation:
NUL is the delimiter and cannot be passed inside an argv element.

## Alternatives

- **Source generated shell assignments:** concise, but escaping mistakes or
  untrusted values can execute code in the interactive shell.
- **Capture fd 3 through command substitution:** introduces shell-specific capture
  and quoting behavior while the foreground client also needs direct tty access.
- **Line-delimited fields:** easy to read, but multiline buffers require another
  escaping convention shared by all three shells.

## Consequences

Values such as `$(touch example)` remain editable text when returned as a buffer.
The nonce prevents applying an unrelated invocation's directives; it is not a
sandbox against an agent already able to run tools as the user. This decision
protects the client-to-shell handoff, without changing the agent's permissions.

[DESIGN §4.1.0](../DESIGN.md#410-common-plugin-contract) defines the whitelist and
readers; [§10](../DESIGN.md#10-security) requires a private runtime directory.
Implementation needs matching writers and readers plus cleanup/error handling.
Property tests through real zsh, bash, and fish readers must preserve supported
values, ignore unknown keys and stale nonces, and show that restoring command
text does not execute it.
