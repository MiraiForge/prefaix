# S7: raw tty inside shell widgets

**Status: resolved, 2026-10-07.** Keep Node/libuv's saved tty-mode restoration.
No extra `stty -g` save/restore subprocess is required on the tested paths.

## Question and method

Does a raw-mode Node child restore the mode inherited from a shell widget,
rather than replacing it with generic cooked mode? Are Ctrl+C, arrows,
typeahead, and SIGWINCH handled without corrupting the editor?

`test/e2e/spikes.spec.ts` starts a small Node child **through each production
plugin's Enter widget**. In the child, `stty -g` captures inherited mode,
`process.stdin.setRawMode(true)` enters raw mode, and a resize must reach
stdout's resize event. Ctrl+C must arrive as byte **3**, not terminate the child.
After `setRawMode(false)`, a second snapshot must equal the inherited mode
**exactly**, while the raw snapshot must differ. The parent then runs a normal
command to prove editor recovery.

Separate real-client/FakeAgent probes send a complete arrow sequence, resize,
typeahead, and a lone abort Esc. Restored typeahead must remain editable; it is
cleared with Ctrl+C, not executed. Unit KeyDecoder tests cover fragmented
escape/UTF-8 sequences and the 25 ms lone-Esc disambiguation boundary.

The shared production-client PTY suite additionally compares termios before/
after Esc and Ctrl+C aborts in emacs/vi modes, verifies subsequent foreground
interrupts, and tests daemon death and non-executing restored buffers.

## Results and evidence

All three widget-invoked raw children restored exact inherited modes, received
byte 3, observed resize, and returned to a usable editor.

Linux floor/current complete suites: **134 passes / 9 optional skips each**.
Final addon/native probes: **10/10** on both pairs. Bash 5.1/5.2 focused suites
are supplemented by complete bash-only suites with **60 passes each**. Logs:
`build/spikes/M1-shell-native-20261007/`.

Committed macOS/Linux lifecycle and tty suites at `72d512b` pass in
[CI run 37573150805, attempt 2](https://github.com/MiraiForge/prefaix/actions/runs/37573150805).
The direct child-in-widget snapshot probe is new **Linux** evidence; do not
claim that the new test itself ran on macOS. CI's production-client restoration
checks are separate evidence.

## Decision and limits

Libuv restores the mode saved when the child entered raw mode, including a
non-generic inherited widget mode. Keep idempotent restoration on normal, error,
abort, and signal paths; do not add a shell subprocess to every production turn
without a reproduced restoration failure.

Keep complete escape sequences distinct from a lone Esc, and keep SIGWINCH
width updates. A buffered arrow can be preserved literally as typeahead; these
tests clear that buffer rather than claim a richer line-editor interpretation.

This is not a proof about every physical terminal, WSL, font, signal interleaving,
or a three-day user trial. Those acceptance boundaries remain explicit.
