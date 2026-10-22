# Native checks for Buildkite manual CI

The migration targets Buildkite organization `mirai-forge`. Manual build/test
controls move there; native macOS checks continue on GitHub-hosted macOS.
`buildkite-native.yml` is the native-only dispatch target for that route. It
does not replace the current CI workflow until the matching protected Janus
admission, dispatcher and evidence verifier have passed live commissioning.

The workflow always runs eight macOS lanes: Check and Performance on Node
22/24/26, and the two existing Bash/Fish combinations. Their original 20/90-minute
limits and benchmark baselines are preserved. The flake choice enables the
50-rerun shell gate; a selected `v*` tag also enables it. The Pi choice is recorded
in source evidence, but Pi runs independently on Janus and does not become a
required native matrix dependency. This workflow has no Linux coordinator,
publisher, deployment job, package credential, or writable GitHub token.

The protected dispatcher must call this workflow on `main`, supplying:

| Input | Meaning |
|---|---|
| `request_id` | Unique UUID persisted before dispatch; uncertain requests must be reconciled rather than resent |
| `build_id` | Owning Buildkite build UUID |
| `source_sha` | Full frozen commit SHA in `MiraiForge/prefaix` |
| `source_ref` | Frozen `refs/heads/...` or `refs/tags/...` selection |
| `source_digest` | SHA256 of the complete protected Buildkite source record |
| `flake_gate` / `pi_smoke` | The two frozen boolean manual choices |

The controller checkout uses `github.workflow_sha`; the test checkout uses
`source_sha`. The source helper runs from the controller checkout, before
dependency installation or project commands. It verifies both clean checkouts
against the original repository, records actual commit/tree/parent identities,
and binds the source choices to the request, build, workflow, run, attempt,
check-run and matrix lane. It uploads an immutable source artifact before running
repository code. Arbitrary branch code cannot replace that helper by changing
its own copy of the file.

The external verifier must pin the reviewed workflow and both helper blobs
(`buildkite-native-source.ts` and `native-source.ts`) at the actual workflow SHA.
It must compare every source field with the authenticated Buildkite admission,
require all eight jobs and their expected steps to succeed on the intended
hosted macOS runners, bind artifacts to exact job/attempt upload IDs and digests,
and re-read provider state before admitting the Buildkite aggregate. A matching
run title, a caller-supplied UUID, or a source artifact alone is insufficient.
Cancellation and uncertain dispatch are owned by that external adapter; no
running GitHub job waits for Linux work.

Before cutover, verify all four option combinations, branches and annotated/
lightweight tags, moved/deleted refs and frozen retries, rejected source/choice
substitution, native failure/cancellation/rerun behavior, queue-time independence,
and artifact binding through real UI/API builds. Keep existing CI available as
rollback until these checks pass. This prepared workflow alone does not prove
Buildkite migration completion and does not authorize a release.
