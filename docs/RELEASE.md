# Prefaix 0.1.0 release gate

M3 implementation does not authorize publishing. `package.json` stays private
until Allan explicitly approves the release after all gates below have current
evidence. Beads `prefaix-mbd.13` is the release task.

| Gate | Evidence required |
|---|---|
| Code quality | Full check, >=95% coverage in every metric, contract suite |
| Shell compatibility | DESIGN scenarios 1–9 and 11–12 across all three shells on macOS and Linux, including the supported versions |
| Stability | <1% failures over 50 reruns per CI matrix entry |
| Performance | Every DESIGN §9 budget passes on the M-series Mac and Linux CI, including post-burst idle RSS; S8 records the startup-runtime comparison |
| Daily-driver doctor | Clean result after removing Forge from the invoking shell |
| Daily use | Allan's three-day trial on at least two shells; no tty corruption or lost typeahead |
| Documentation | Allan's fresh-machine walkthrough using only the README |
| Required checks | `M3 required checks` enforced for `main` through a branch rule |
| Publishing approval | Allan's explicit go for the exact release version |

`main` had no branch protection or repository rulesets when inspected during
M3 implementation. A workflow in the repository does not itself configure
GitHub's required checks. Configure that rule when the new workflow has run
successfully and commit/push authority has been granted.

`prefaix.dev` did not resolve in the implementation environment. Its placeholder
is prepared in `site/index.html`, with a direct link to the README and no build
step or external assets. Deploy the `site` directory to the approved static host
and connect the domain as part of release preparation. Deployment and live
verification still need approval before release.

Allan explicitly allowlisted Node major 26 for daemon idle RSS. Its measured
overrun of the <60 MB target (60,000,000 bytes, or 57.22MiB) is now an approved
exception, not a release blocker. The performance report retains every RSS
sample and labels overruns `idleMemoryBudget.status = "allowlisted"`. Timing,
throughput, valid measurements, and the original memory budget on every other
Node major remain enforced. This exception does not approve publishing or
satisfy the other release gates.

## Publishing mechanism

The prepared `release.yml` workflow is tag-triggered. It first runs the full CI
workflow, including the 50-rerun stability gate. The publish job uses the `npm`
GitHub environment and refuses to proceed unless all of these are true:

- The manifest has `private: false` and a stable version other than `0.0.0`.
- A push event names exactly `v<package version>`.
- The `APPROVED_RELEASE_VERSION` environment/repository variable equals that
  exact version.

Those settings remain absent/private during implementation. Configure an
approval reviewer on the `npm` environment before authorizing a release.

npm trusted publishing must be configured for GitHub organization `MiraiForge`,
repository `prefaix`, workflow **`release.yml`**, and environment **`npm`**.
Enable the direct `npm publish` action in that trusted publisher. The workflow
uses Node 24, npm 11.5.1, `id-token: write`, and `npm publish --provenance` on a
GitHub-hosted runner. See npm's [trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/).
Trusted-publisher configuration and initial package availability must be checked
in the npm account at release time; neither is asserted complete by this code.

After explicit approval, set the package version to `0.1.0`, flip `private`,
set `APPROVED_RELEASE_VERSION=0.1.0`, commit the reviewed release state, and push
its `v0.1.0` tag. These are release actions and require the same approval.

The workflow publishes, installs the exact registry version into a clean
prefix, checks the CLI and all init outputs, and creates a GitHub release from
`docs/releases/0.1.0.md`. Inspect the npm provenance and complete the README
walkthrough on a clean machine. Confirm that the prefaix.dev placeholder links
to the README. Record URLs and results in Beads before closing M3.
