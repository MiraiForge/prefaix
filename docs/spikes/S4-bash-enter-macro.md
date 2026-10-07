# S4: bash Enter macro and dynamic rebind

**Status: resolved, 2026-10-07.** Retain the two-step Enter macro and a
**bash 4.4** interception floor; bash 3.2 keeps the explicit `pfx` fallback.

## Question and method

Can a `bind -x` function inspect/intercept the buffer, then dynamically choose
whether the macro's second key accepts the line or leaves an editable suggestion?

Use the production plugin, node-pty, and a headless xterm, rather than a static
binding inspection. The suite checks passthrough, literal history, multiline and
bracketed paste, vi bindings, empty accept/refresh, Unicode cursor restoration,
and restored directives that wait for Enter. A real built client uses FakeAgent.

Additional opt-in `test/e2e/spikes.spec.ts` probes launch a Node raw-mode child
**from the actual widget**. They compare `stty -g` inside that child before
and after raw mode, receive Ctrl+C as byte 3, observe resize, and exercise the
real client's arrow/typeahead handling. The addon case loads actual
bash-preexec and Starship in an isolated HOME.

Bash 4.4/5.1/5.2 binaries were built from official GNU archives with pinned
SHA-256 checks in `scripts/install-test-shell.mjs`. The 5.1 archive pin is
also recorded by Homebrew core commit
`fe47217500e2c2131751e5dec2bb32b3da77eff4`; it is the **base 5.1 release**,
not Homebrew's patched 5.1.8 binary.

## Results and evidence

- Linux bash **4.4**: complete floor-version suite, **134 passes / 9 skips**,
  including ten native/addon probes across three shells.
- Linux bash **5.1** and **5.2**: final complete bash-only suites,
  **60 passes / 9 optional skips each**, following initial 23-case focused runs.
- Host bash **5.3.20**: complete suite, **134 passes / 9 skips**.
- Native macOS/Ubuntu **4.4 and 5.2** matrices at committed `72d512b):
  [CI run 37573150805](https://github.com/MiraiForge/prefaix/actions/runs/37573150805),
  green on attempt 2. macOS also exercised its bash 3.2 fallback.

Private logs: `build/spikes/M1-shell-native-20261007/` (`low.log`,
`bash51-full-final.log`, `bash52-full-final.log`, `current.log`). Final strengthened addon probes
passed ten cases on both floor/current pairs in `*-addons-final-v2.log`.
The nine full-suite skips are optional terminal/platform cases, not omitted
required shells. No models or real rc files were involved.

## Decision

The macro must retain a dynamically rebound second key: ordinary lines accept,
while editable restored directives do not execute. Empty accept reruns
PROMPT_COMMAND correctly; history and vi mode work at 4.4. Raising the floor to
5.0 would provide no demonstrated benefit.

bash-preexec **0.7.0** (commit
`5ae4758c36e8391fb3932e6ae68c283489fc813d`) and Starship **1.26.0** coexist in
the native probe. This is not direct acceptance of every Atuin/fzf/mcfly release;
keep those combinations in broader terminal/addon validation rather than claim
they were loaded here. No forced `stty` restoration is needed (see S7).
