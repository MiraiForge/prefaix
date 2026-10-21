# Native matrix source evidence

Each of the eight hosted macOS validation lanes captures its checkout identity
before package scripts or dependency installation, then uploads `source.json` as
`native-source-<run-id>-<attempt>-<check-run-id>`. Artifacts are immutable and retained
for 36 days. Capture or upload failure fails that lane. Linux checks, native tests,
conditional stability sweeps, the M3 aggregate, and the release dependency remain
authoritative.

The record identifies the actual Git commit, tree and raw merge parents; repository
and fork identity; source branch, base branch and tested ref; workflow run attempt;
native matrix lane; typed manual choices; and whether the original condition
requires the 50-rerun stability sweep. Pi's optional choice is recorded but does not
become an aggregate dependency. A tag's event object is recorded separately from
the checkout commit so a consumer can verify annotated tag peeling.

Caller and job workflow identities are separate. GitHub associates the `github`
context with the caller of a reusable workflow; `job.workflow_*` identifies the
workflow defining the job. This preserves the distinction between direct CI and
the release workflow's `verify` call. See GitHub's [context reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context).

This record describes source identity, not test success or permission to publish.
A future protected Janus aggregate must independently verify the reviewed workflow
and capture-script blobs, current GitHub run and attempt, all eight expected hosted
macOS jobs and steps, immutable artifact IDs/digests and the upload step, current
source/merge/base identity, and matching successful Linux Buildkite results. It
must reject missing, stale, canceled, failed or substituted evidence. Fork evidence
must never admit fork code to the trusted Janus pool. The consumer must validate
effective stability choices against the authenticated triggering event or reviewed
manual request, rather than treating this JSON as authorization.

The capture uses only Node built-ins and read-only Git commands, writes outside the
checkout, and emits a generic error on failure. It receives no additional secret or
API permission. No Buildkite pipeline, required check, runner, release trigger or
publisher is enabled by this preparation.
