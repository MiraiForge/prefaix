# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd prime` for full workflow context.

> **prefaix-specific:** this GitHub repo is public, but its beads database is **private** on
> DoltHub (`https://doltremoteapi.dolthub.com/aditzel/prefaix`, configured as Dolt remote `origin`
> and `sync.remote`). Never add the GitHub repo as a Dolt remote and never push `refs/dolt/data`
> to GitHub — the generic note below does not apply here. All `.beads/*.jsonl` files (audit
> log, issue exports) are gitignored and must stay out of git; issue data lives only on DoltHub.
> Plan of record: `docs/DESIGN.md`, `docs/ROADMAP.md`.

> **Architecture in one line:** Issues live in a local Dolt database
> (`.beads/dolt/`); cross-machine sync uses `bd dolt push/pull` (a
> git-compatible protocol), stored under `refs/dolt/data` on your git
> remote — separate from `refs/heads/*` where your code lives.
> `.beads/issues.jsonl` is a passive export, not the wire protocol.
>
> See [SYNC_CONCEPTS.md](https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md)
> for the one-screen overview and anti-patterns (don't treat JSONL as the
> source of truth; don't `bd import` during normal operation; don't
> reach for third-party Dolt hosting before trying the default).

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
the conservative Git/sync profile below for commit, push, and Dolt sync authority.

**Never publish without Allan's explicit approval.** Keep `package.json` set to
`"private": true` until the M3 release gate is met and Allan authorizes the first
`0.1.0` release. Flipping that flag, creating a publishing release tag, or triggering
a publish workflow is part of the release action; implementation work alone does
not authorize it. `npm publish --dry-run` does not enforce `private` and is not a
substitute for the release gate.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

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

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
