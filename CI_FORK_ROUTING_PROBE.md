# Hosted fork CI routing probe

Do not merge this disposable research PR.

This probe checks ordinary pull-request CI routing from
`aditzel/prefaix-janus-ci-probe` into `MiraiForge/prefaix` at source commit
`c2bd316a1e763ae2b1dd2424532497a4b1cf92d4`.

The existing CI and release workflows are unchanged. Baseline commit `a620e493`
passed [run 39153700726, attempt 2](https://github.com/MiraiForge/prefaix/actions/runs/39153700726).
Only afterward, additive commit `39480712` introduced a deliberately failing unit
test. [Run 39200937814, attempt 2](https://github.com/MiraiForge/prefaix/actions/runs/39200937814)
verified all six Check lanes failed only on that marker while all performance and
shell jobs passed; the required aggregate rejected the Check failure. Original
performance failures and unchanged-source rerun evidence are retained.

The recovery commit removes the marker. Recovery must meet the same complete
acceptance criteria below before this probe is closed without merging.

A successful baseline requires all 17 ordinary Linux/macOS jobs to pass,
including the required aggregate check. Every executed job must use a
GitHub-hosted runner with read-only permissions. All six platform/Node variants
must retain both startup and performance artifacts. The optional Pi smoke and
all four 50-rerun stability steps must be skipped for this ordinary fork PR.
An incomplete run does not count as baseline success.

The fork is owner-authored, so it verifies routing and required-check behavior,
not the approval prompt for an external contributor.

Research context: <https://plan.ref.tools/byBZqHCjVyximERp>.
