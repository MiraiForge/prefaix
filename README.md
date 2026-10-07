# prefaix

Prefix your prompt with `:` and keep working in your shell. Prefaix connects
zsh, fish, and bash to [pi](https://github.com/badlogic/pi-mono), streams its
answer below your prompt, and returns your terminal when the turn ends.

The M3 implementation is under validation. **The npm package is not published
yet.** See the [release gate](docs/RELEASE.md), [design](docs/DESIGN.md), and
[roadmap](docs/ROADMAP.md).

## Roadmap

Progress snapshot as of **2026-10-07**. Implementation and release acceptance
are separate: the core is complete and the triple-shell MVP is implemented,
but **0.1.0 has not shipped**.

| Milestone | Status | Finished | Remaining |
|---|---|---|---|
| **M0 — Foundations** | Complete | Strict TypeScript tooling, builds, CI, architecture/ADRs, layering checks, and private-package safeguards. | Ongoing maintenance. |
| **M1 — Design spikes** | Complete for measured decisions | S1 lifecycle; S2 pool economics; S3 safe cwd policy; S4–S7 shell/addon/tty mechanics; S8 macOS/Linux startup; S9 bridge/tools/UI. Eleven reviewed native pi fixtures. | Broader terminal/addon versions and long-held native dialog/cancellation hardening; these do not become verified merely because replay passes. |
| **M2 — Core** | Complete | Backend-independent AgentPort, fake and pi adapters, bridge, daemon/pool/store, foreground client, safe directives, renderer, CLI, and contracts; cumulative usage/cache-cost accounting, verified live provider/model selection, and resume/bridge/UI fixes. | Ongoing hardening, including long-held native dialog timeout/cancellation. |
| **M3 — Triple-shell MVP → 0.1.0** | Implemented; acceptance in progress | zsh/fish/bash plugins, bash 3.2 fallback, MVP commands, pickers, prompt status, doctor, setup/uninstall, docs, and passing macOS/Linux shell/version and performance CI at `72d512b`. | Fresh release-artifact CI/stability, human walkthrough/daily-use checks, required-check enforcement, release preparation, and explicit publishing approval. |
| **M4 — Parity and beyond Forge** | Planned | Foundations from the core and MVP. | Command suggestions and commit drafting, detach/attach, steering, personas, completions, TUI handoff, additional conversation commands, richer context capture, and terminal polish. |
| **M5 — Hardening → 1.0** | Planned | Backend abstraction and safety checks to build on. | A second adapter and backend switching, security review, wider distribution/docs site, WSL/terminal validation, and conditional compiled-client/ble.sh work. |

[S1](docs/spikes/S1-pi-rpc-lifecycle.md) combines real Kimi turns with native pi
against a **controlled loopback API** for retry/compaction. [S2](docs/spikes/S2-agent-pool-economics.md),
[S3](docs/spikes/S3-cwd-follow.md), and [S9](docs/spikes/S9-pi-bridge-extension.md)
use controlled native probes, not natural provider measurements. Shell/TTY
[S4](docs/spikes/S4-bash-enter-macro.md), [S5](docs/spikes/S5-zsh-widget-coexistence.md),
[S6](docs/spikes/S6-fish-binding-history.md), [S7](docs/spikes/S7-raw-tty-widgets.md),
and the cross-platform [S8](docs/spikes/S8-client-startup.md) now have written
results and decisions. M1 decisions do not replace M3 human/release acceptance.

**Next: finish the 0.1.0 acceptance and release gates.**

- Keep supported-shell/version and performance CI green for the release
  artifact. [CI at 72d512b](docs/VALIDATION.md#native-ci-evidence-2026-10-07)
  is green on both platforms. That recorded run does not validate later changes:
  require a green run for the new commits and fresh frozen-artifact stability
  evidence before release acceptance.
- Confirm a clean daily-driver doctor result, a fresh-machine README walkthrough,
  and three days of daily use on at least two shells without tty corruption or
  lost typeahead.
- Enforce the required CI checks and prepare/verify npm trusted publishing and
  the prefaix.dev placeholder. Publishing still needs Allan's explicit approval;
  the package stays private until then.

The [detailed roadmap](docs/ROADMAP.md) defines tasks and acceptance criteria;
the [validation guide](docs/VALIDATION.md) and [release gate](docs/RELEASE.md)
define the remaining evidence. Beads remains the live task source of truth;
this section is a public progress summary, not a separate task tracker.

### Local validation snapshot

The completed M1/hardening changes passed these local gates on **2026-10-07**:

| Gate | Result and scope |
|---|---|
| `bun run check` | Lint/typecheck/unit and contract tests: **1,818 passed**, 10 expected broken-backend failures, 10 opt-in skips. |
| `bun run coverage` | **97.74% statements / 95.60% branches / 95.89% functions / 98.07% lines**; all exceed 95%. |
| Shell PTY suites | **134 passed** on each Linux floor/current pair; complete bash 5.1/5.2 suites **60 passed each**. Optional terminal/platform cases stay labeled as skips. |
| Build and `test:pi-smoke` | Distributable bundles build; real pi **1.0.4** answers offline RPC queries, idle abort, and shutdown without a prompt, model request, or credentials. |
| `test:perf` | Built client/daemon with **FakeAgent**: hello p50/p95 **32.31/37.20ms**, first-token p50 **50.36ms**, about **25,933 deltas/s**; maximum idle daemon RSS **54.62MiB**, below the **57.22MiB** budget. |
| Docs/package/style guards | Generated config reference matches the schema; `private: true` remains set; formatting and diff-whitespace checks pass. |

These gates do not establish real-provider latency or credential validity,
constitute a comprehensive security/secrets audit, prove long-held native UI
cancellation, or replace the human release trial. The new evidence collection
used fake/replay or controlled loopback APIs: **no paid model requests**.
Full methods, artifacts, and evidence limits are in [the validation guide](docs/VALIDATION.md).

## Install from source

Use Node 22.19+ and Bun 1.3.14. Full interception requires zsh 5.8+, fish 3.6+,
or bash 4.4+. macOS `/bin/bash` 3.2 provides the `pfx` fallback.

```sh
git clone https://github.com/MiraiForge/prefaix.git
cd prefaix
bun install --frozen-lockfile
bun run build
npm install --global .
```

Install and configure pi using its [installation instructions](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).
The minimum supported pi is 0.87.1; current native lifecycle/bridge evidence
uses pi 1.0.4. Authenticate with your preferred provider and choose a model in
pi before your first real prompt.

Add **one** line to your shell's rc file, then open a new shell:

| Shell | Rc file | Line |
|---|---|---|
| zsh | `~/.zshrc` (or `$ZDOTDIR/.zshrc`) | `eval "$(prefaix init zsh)"` |
| fish | `~/.config/fish/config.fish` | `prefaix init fish \| source` |
| bash | `~/.bashrc` | `eval "$(prefaix init bash)"` |

Or run `prefaix setup --shell zsh` (also `fish` / `bash`). It previews the rc
change, asks before writing, and saves a backup. `--dry-run` only previews;
`--yes` applies without a prompt. Repeating setup is safe.
`prefaix uninstall --shell zsh` removes its managed block while retaining other
settings, conversations, and pi.

Bash login shells (including many macOS terminal sessions) read a login profile
instead of `~/.bashrc`. Add this line to the first existing file among
`~/.bash_profile`, `~/.bash_login`, and `~/.profile`, or create `~/.bash_profile`
if none exists:

```sh
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
```

Setup prints this guidance and only edits `~/.bashrc`.

Remove the Forge plugin line first: both intercept Enter and `:`. Load Prefaix
before zsh-syntax-highlighting. ble.sh is unsupported. On bash 3.2 use
`pfx 'explain this repo'`, or `pfx` for a readline prompt. Install a newer bash
with `brew install bash` for interception and typeahead restoration.

## Five things to try

```text
: explain how this repository starts
:new investigate the failing auth test
:model
:think high
:info
```

`: <text>` continues the active conversation. `:c` opens the conversation
picker, and `:c -` toggles back. Pickers use fzf when available, or a builtin
keyboard list; `PREFAIX_UI_PICKER=builtin` forces the latter.

Esc or Ctrl+C aborts a turn. Text typed during a turn returns in the next prompt
buffer and waits for Enter. Restoring text never executes it.

Fish 3.6 uses a history-merge compatibility fallback: a short turn can take up
to about one extra second to return to the prompt so ↑ immediately recalls the
exact prompt. Streaming starts immediately; fish 4.x does not need this delay.

Normal commands still run in your shell. Bare `:`, `: >file`, and `: ${X:=1}`
remain shell builtins. A leading space (` : ...`) or escaped colon (`\: ...`)
bypasses Prefaix. Quotes, dollar signs, globs, and pipes in prompts are literal
text sent to the agent.
Keep the space after `:` for a prompt. A tight name such as `:model` is a
command; an unknown tight name reports suggestions rather than prompting a model.

## Commands and coming from Forge

| Intent / Forge command | Prefaix |
|---|---|
| Ask in the current conversation | `: <text>` |
| Start fresh (`:new`, `:n`) | `:new [text]`, `:n [text]` |
| Switch (`:conversation`, `:c`) | `:c [query]`; `:c -` toggles back |
| Choose a model (`:model`, `:m`) | `:m [query]` |
| Set reasoning (`:think`) | `:think [level]`; levels come from the backend |
| Inspect context (`:info`, `:i`) | Model, thinking, root, usage, backend, daemon |
| Copy the answer (`:copy`) | `:copy` via pbcopy, wl-copy, xclip, or terminal OSC 52 |
| Help (`:help`, `:?`) | `:help`; agent commands are included when connected |
| Diagnose the installation | `:doctor` or `prefaix doctor` |
| Run a pi command or skill | `:/command [args]`, e.g. `:/skill:review` |
| Suggest, commit, detach/attach, TUI handoff | Planned for M4 |

## Prompt integration

`prefaix_prompt_info` prints cached status using shell builtins, without
calling Node or the daemon on prompt draw.

- zsh: `[ui] rprompt = "on"` opts into the right prompt; `auto` respects an
  existing theme, and `off` disables it.
- fish: wraps the existing `fish_right_prompt`, retaining its output.
- bash: add the cached variable to a single-quoted prompt, for example
  `PS1='${PREFAIX_STATUS} \w \$ '`. The precmd hook refreshes it with builtins.

Starship users can use the native zsh/fish right prompt without external
processes. The optional custom module below launches commands through
Starship, so it is outside Prefaix's zero-process prompt budget. In a zsh
`precmd` hook, set `export PREFAIX_STARSHIP_STATUS=$PREFAIX_STATUS`, then add:

```toml
[custom.prefaix]
when = 'test -n "$PREFAIX_STARSHIP_STATUS"'
command = 'printf "%s" "$PREFAIX_STARSHIP_STATUS"'
format = '[$output]($style) '
```

## Configuration and troubleshooting

The generated [configuration reference](docs/CONFIGURATION.md) lists every
setting and environment override. Run `prefaix config check` after editing
`~/.config/prefaix/config.toml`.

```toml
[ui]
picker = "builtin"

[workspace]
cwd_policy = "split" # pi resumes in the original session cwd; split is safe across roots.
```

A conversation is rooted at a project directory. **`split` is the default**
and selects a separate conversation per root; `stay` keeps the original root.
`follow` requires backend support. Pi 1.0.4 restores its original session cwd,
so the adapter refuses cross-root resume rather than silently running tools in
the wrong directory. Same-root resume, including canonical/symlink aliases,
remains supported.

| Symptom | Action |
|---|---|
| `:` does nothing | Run doctor, check the rc line, and restart the shell. bash 3.2 uses `pfx`. |
| Forge / ble.sh conflict | Remove the conflicting plugin line, then open a new shell. |
| pi missing or old | Install/upgrade pi and run doctor again. |
| Invalid config | `prefaix config check` names the invalid key or TOML location. |
| Daemon unavailable after a crash | Try another prompt (autospawn recovers); inspect startup with `prefaix daemon --foreground`. |
| Runtime permissions rejected | Your runtime directory must be owned by you and mode 0700; its socket must be mode 0600. |
| Clipboard unavailable | Install `wl-clipboard` (Wayland) or `xclip` (X11), or enable OSC 52 clipboard support in your terminal. |
| Empty model picker | Configure provider credentials in pi. |

Doctor prints ✓/⚠/✗ with fixes and never prints environment values. It does not
edit your rc or send a model request. `prefaix conversations ls`,
`prefaix conversations show <id>`, and `prefaix debug tap <id>` inspect local
state.

## Development

```sh
bun run check
bun run coverage
bun run test:e2e
bun run test:perf
bun run docs:check
```

Tests use the fake backend and pi fixtures. Coverage must reach 95% for
statements, branches, functions, and lines. `bun run test:pi-smoke` probes pi
without a model request. Live tests require `PREFAIX_LIVE_PROVIDER` and
`PREFAIX_LIVE_MODEL`; the guard refuses Anthropic/OpenAI providers, including
OpenRouter variants.

For a no-cost demo, export `PREFAIX_BACKEND=fake` and optionally
`PREFAIX_FAKE_SCENARIO=long` before opening the shell. Unset these and stop the
demo daemon (`prefaix daemon stop`) before returning to pi.

See the [validation guide](docs/VALIDATION.md) for the shell version matrix and
50-rerun gate. Beads is the task source of truth; its private DoltHub data must
never enter the public repository. Publishing requires Allan's explicit
approval, separate from implementation.

## License

Apache-2.0
