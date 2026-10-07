# S5: zsh widget and plugin coexistence

**Status: resolved, 2026-10-07.** Retain empty accept for run-class results,
reset-prompt for editable results, and rebinding after zsh-vi-mode initialization.

## Question and method

Does `zle -I` plus empty accept return cleanly without Forge-style BUFFERLINES
padding, while preserving wrapped widgets, bracketed paste, and theme behavior?

The shared PTY suite runs the production zsh plugin and verifies literal input,
history, identity, vi bindings, refresh, Unicode/restored buffers, and tty
handoff. Opt-in native probes add **real** zsh-vi-mode, autosuggestions,
syntax-highlighting, and Powerlevel10k, with isolated HOME/XDG state and no
user rc edits. The built client uses FakeAgent, never a provider.

The p10k case first starts cold, confirms that p10k generated its actual
instant-prompt cache, closes the shell, and starts again with the **same HOME**
and the real cache source line. It then performs a bracketed-paste turn, abort,
editable typeahead recovery, and an ordinary command. Gitstatus downloading and
the configuration wizard are disabled; instant prompt is `quiet`.

The harness has an explicit marker matcher for theme probes. Ordinary suites
still require the exact empty `__pfx` prompt. Theme matching must reject a
prompt containing an editable buffer; repaint alone is not input readiness.

## Results and evidence

Linux zsh **5.9.2** passes the full floor/current suites:
**134 passes / 9 optional skips each**. Final addon/TTY probes pass **10/10**
on both pairs. Native macOS zsh and baseline lifecycle also pass in the
[green current-commit CI](https://github.com/MiraiForge/prefaix/actions/runs/37573150805).

Versions used for addon evidence:

| Addon | Version / provenance |
|---|---|
| zsh-vi-mode | 0.12.0, commit `91cafe4a09b6670cb8e761aa413e5f7b9e00816f` |
| zsh-autosuggestions | 0.7.1 |
| zsh-syntax-highlighting | 0.8.0 |
| Powerlevel10k | 1.20.18 |

The downloaded vi-mode source SHA-256 is
`3b9a1971baa17f173ee3fc74e58ed8ebdb856f356cb830476c29d558b9c62e22`.
It lives outside the repository; tests do not fetch addons or change global
settings. Logs remain in `build/spikes/M1-shell-native-20261007/`.
Initial failures were fixture readiness/marker mistakes; they were not hidden
with retries. Final theme tests prove editor readiness using bracketed paste.

## Decision

- Keep `zle accept-line` delegation so neighboring wrappers run.
- Load prefaix before syntax-highlighting, and register rebinding in
  `zvm_after_init_commands`.
- Use empty accept after run results so precmd runs; use reset-prompt for
  editable suggestions. No additional BUFFERLINES padding is justified.
- p10k's real instant-prompt cache works in the tested configuration without
  duplicate empty prompt rows. This is not a claim about every theme config,
  font, terminal emulator, or addon version.

The addon combination was measured on Linux; the committed CI's macOS baseline
did not load these addon versions. Wider terminal/addon acceptance remains
distinct from this design decision and from the human M3 daily-use gate.
