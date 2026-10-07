# S6: fish Enter binding, history, and repaint

**Status: resolved, 2026-10-07.** Retain the current binding, literal history-file
import plus merge, identity abbreviation, and repaint/empty-execute split.

## Question and method

Do fish 3.6 and 4.x preserve the literal prompt, vi bindings, and editable
suggestions? Can Starship's right prompt be wrapped instead of overwritten?

Run the production plugin with node-pty/headless xterm, isolated HOME/XDG state,
and the built FakeAgent client. Floor **3.6.4** was built from the pinned official
archive. The host **4.9.3** provides additional 4.x evidence; committed CI also
runs exact **4.0.2** natively on macOS and Ubuntu.

The opt-in Starship **1.26.0** probe sets `ui.rprompt = "on"`, confirms the
prefaix right-prompt wrapper actually exists, and retains Starship's `right`
marker beside prefaix's cached status. It resizes, exercises bracketed paste,
aborts, edits restored typeahead, runs an ordinary command, and checks history.
It also verifies the installed regex abbreviation and byte-preserving
`__prefaix_abbr :info` expansion.

## Results and evidence

- Floor/current complete Linux suites: **134 passes / 9 optional skips each**.
- Final native/addon cases: **10/10** on each pair, including actual right-prompt
  wrapping, identity abbreviation, and raw tty restoration.
- Exact 3.6.4/4.0.2 baseline matrices on both OSes:
  [green CI at 72d512b](https://github.com/MiraiForge/prefaix/actions/runs/37573150805).

Private logs: `build/spikes/M1-shell-native-20261007/`; final strengthened
wrapping checks are in `low-addons-final-v2.log` and
`current-addons-final-v2.log`. Earlier rprompt-off probes only proved
non-clobbering; they are **not** the evidence for wrapping.

## Decision

Supported fish versions do not provide `history append`. Save native history,
append one literal entry with fish's backslash/newline encoding, then merge.
Do not substitute a command that is unavailable at the floor.

Fish 3.6 imports a new timestamp after its next whole-second boundary; retain
the bounded post-client merge/readiness loop. Short turns can wait about one
second. Fish 4.x usually imports immediately. Readiness comes from history
contents, not a separate clock probe.

For a run-class result with no restored buffer, execute the empty line so prompt
events run. For editable results, repaint and leave the buffer waiting for Enter.
Retain bindings in default/insert modes and reinstall after vi-keymap changes.

Keep the command-position regex abbreviation as an **identity expansion**:
highlighting must not rewrite user input or change the authoritative grammar.
Wrap the original right prompt, preserving its status and text. Other themes
and addon versions remain broader compatibility work, not implied by this probe.
