# Janus native CI acceptance

A trusted pull request targeting `main` exercises the ordinary Janus lane without
changing the release configuration. Record the exact PR head and tested merge
commit alongside the Buildkite build and native GitHub Actions run.

Acceptance requires the protected Linux jobs to pass, the native workflow to
verify the same frozen source, and the native waiter to unblock only that build.
An uploaded image or a successful service health check does not establish those
results. Preserve the provider job results when reporting the final aggregate.

Keep the hosted checks enabled while collecting this evidence. This procedure
does not authorize package publication or changes to the release gate.
