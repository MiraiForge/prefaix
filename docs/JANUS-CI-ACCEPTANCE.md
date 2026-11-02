# Janus native CI acceptance

A trusted pull request targeting `main` provides ordinary Janus evidence only
when the enabled Buildkite lane and corresponding hosted `.github/workflows/ci.yml`
run execute for it. Record the exact PR head and tested merge commit alongside
the Buildkite build and hosted GitHub Actions run. The separate manual dispatcher
and `buildkite-native.yml` are not prerequisites for this ordinary PR path.

Acceptance requires the protected Linux jobs to pass, the native workflow to
verify the same frozen source, and the native waiter to unblock only that build.
An uploaded image or a successful service health check does not establish those
results. Preserve the provider job results when reporting the final aggregate.
Apply the checks in [the native verifier contract](ci-native-source.md) before
accepting the run, including all eight macOS lanes and immutable source artifacts.

Keep the hosted checks enabled while collecting this evidence. This procedure
does not authorize package publication or changes to the release gate.
