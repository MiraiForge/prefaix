# Agent Instructions

> Plan of record: `docs/DESIGN.md`, `docs/ROADMAP.md`.

## Prefaix conventions

[DESIGN.md](docs/DESIGN.md) defines the architecture; [ROADMAP.md](docs/ROADMAP.md)
defines delivery milestones. Keep the project conventions in `AGENTS.md` and
`CLAUDE.md` consistent. Pending design spikes are assumptions to validate, not
established behavior.

### Layering and shell safety

- `src/client/**` and `src/shells/**` must not import `src/agents/**`. Keep agent
  contracts, normalized events, and capabilities in backend-independent `src/core/`.
- `src/agents/registry.ts` is the composition point for concrete adapters. Keep
  pi RPC details, bridge behavior, and tool-summary construction in `src/agents/pi/`;
  the renderer must not learn pi event formats or tool schemas.
- The daemon is headless and relays normalized events. The foreground client owns
  the tty and rendering. Shell plugins handle interception and state restoration;
  the authoritative command grammar lives in `src/shells/grammar.ts`.
- Missing backend capabilities produce a clear unsupported-feature message,
  never a crash. Follow the boundaries in DESIGN §4.4 when adding an adapter.
- Return turn directives as NUL-delimited data with a matching nonce and the
  `conversation`, `status`, `buffer`, and `cursor` whitelist. Never `eval` or
  `source` generated turn directives. Restored suggestions wait for the user to
  press Enter; applying a buffer must not execute it.

### Build and validation

Use Bun for package management and scripts, strict TypeScript with ESM, tsup for
bundling, Vitest for tests, and ESLint with Prettier. For code changes, run
`bun run check` (lint, typecheck, unit tests), plus relevant contract or shell PTY
tests. If a required script is not implemented yet, report that limitation rather
than claiming a passing check. Default to FakeAgent and recorded-fixture tests.

**Coverage target: 95% or better on statements, branches, functions, and lines.**
`bun run coverage` enforces it through `coverage.thresholds` in
`vitest.config.ts`, and CI runs it as its own step, so a change that is not tested
fails the build rather than quietly lowering the bar. `bun run test` stays fast and
measures nothing. Test scripts that throw are not a substitute: the contract suite
in `test/contract/` is run through `it.fails` against a deliberately broken
backend, so a passing contract is known to mean something.

### Live-model cost guard

Never bill Anthropic or OpenAI models in development tests, spikes, or fixture
recordings. Follow DESIGN §12.4 for every operation that sends a model request:

- Require both `PREFAIX_LIVE_PROVIDER` and `PREFAIX_LIVE_MODEL`, and run
  `scripts/live-guard.ts` before the request. If the guard is unavailable, use
  fake/fixture tests or a no-model probe instead of bypassing it.
- Refuse `anthropic*`, `openai*`, and `openai-codex*` providers, including OpenRouter
  model slugs under `anthropic/*` or `openai/*`.
- Pass `--provider` and `--model` explicitly to pi. Never rely on its configured
  default, even if credentials are already available. Record the provider and
  model in fixture headers.
- A no-model smoke may spawn pi, query state/commands/available models, create a
  session, abort while idle, and shut down; it must not send a prompt or otherwise
  invoke a model.

### Commits and publishing

When commits are authorized, match the existing history: use a short imperative,
sentence-style subject, such as `Document prefaix agent conventions.` Keep each
commit focused; explain non-obvious rationale and validation in the body. Follow
the Session Completion protocol below for commit and push authority.

**Never publish without Allan's explicit approval.** Keep `package.json` set to
`"private": true` until the M3 release gate is met and Allan authorizes the first
`0.1.0` release. Flipping that flag, creating a publishing release tag, or triggering
a publish workflow is part of the release action; implementation work alone does
not authorize it. `npm publish --dry-run` does not enforce `private` and is not a
substitute for the release gate.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

## Session Completion

This protocol is subordinate to explicit user, repository, and orchestrator instructions.

1. **Run quality gates** (if code changed) - Tests, linters, builds
2. **Handle git by authority**:
   ```bash
   # Default: report status and proposed commands; wait for approval.
   git status

   # Only when commit and push are explicitly authorized:
   git pull --rebase
   git push
   git status
   ```
3. **Hand off** - Summarize changes, validation, and any blocked commit/push step

**Critical rules:**
- Do not commit or push without clear authority from the current user request.
- If a required push is blocked, stop and report the exact command and error.
