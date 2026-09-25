# prefaix

**PrefAIx** — prefix your prompt with `:` and stay in the shell.

Forge-class shell UX (zsh, fish, bash) with a swappable AI agent backend. First adapter: [pi](https://github.com/badlogic/pi-mono).

- Site: [prefaix.dev](https://prefaix.dev)
- npm: `@miraiforge/prefaix` (not yet published; command will be `prefaix`)

## Status

Pre-implementation. See [docs/DESIGN.md](docs/DESIGN.md) for the technical design and [docs/ROADMAP.md](docs/ROADMAP.md) for milestones and tasks.

## Development

Use Node >= 22.19 and Bun 1.3.14:

```sh
bun install --frozen-lockfile
bun run check
bun run build
```

`check` runs ESLint, Prettier, strict TypeScript checking, and Vitest unit tests.
CI runs the same checks on Ubuntu and macOS with Node 22 and 24. The tests use no
live models; see [AGENTS.md](AGENTS.md) for the live-model restrictions.

Application source is intentionally empty during M0. The build skips with a
notice until `src/cli/index.ts` or `src/agents/pi/bridge.ts` exists, then emits
`dist/prefaix.js` and/or `dist/pi-bridge.js` with source maps. The CLI entry point
must carry `#!/usr/bin/env node`; the build preserves it. Build tests verify both
bundles in temporary fixtures without adding application stubs.

Use `bun run format` to format code and configuration; Markdown is left
hand-wrapped to preserve design documents and generated instruction blocks.
ESLint enforces the import boundaries in DESIGN §4.4, including literal dynamic
imports. The daemon and CLI select adapters through the registry; the client,
shells, and core cannot import adapters at all.

`bun run check:private` verifies that the package remains private. CI permits an
unprivate manifest only on a push of a stable `vX.Y.Z` tag matching the package
version. It does not publish anything; releasing still requires Allan's explicit
approval and the M3 gate.

## License

Apache-2.0
