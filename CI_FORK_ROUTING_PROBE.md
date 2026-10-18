# Hosted fork CI routing probe

Do not merge this disposable research PR.

This documentation-only baseline checks ordinary pull-request CI routing from
`aditzel/prefaix-janus-ci-probe` into `MiraiForge/prefaix` at source commit
`c2bd316a1e763ae2b1dd2424532497a4b1cf92d4`.

The existing CI and release workflows are unchanged. After the baseline
succeeds, a separate additive commit may introduce one deliberately failing unit
test; a later additive commit removes that test to verify recovery. This first
phase contains no failure injection. Close the probe without merging after
verification.

The fork is owner-authored, so it verifies routing and required-check behavior,
not the approval prompt for an external contributor.

Research context: <https://plan.ref.tools/byBZqHCjVyximERp>.
