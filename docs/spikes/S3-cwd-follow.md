# S3: resuming a pi session from another directory

**Status: resolved, 2026-10-07.** Default to `workspace.cwd_policy = "split"`.
Native pi 1.0.4 does **not** safely implement cwd-follow by changing spawn cwd.

## Question and method

Create a session in A, then launch pi from B with `--session <A-file>`.
Does native history survive, and do tools and the system cwd section move to B?

`scripts/spikes/m1-native.ts` creates separate A/B directories with different
`relative.txt` contents. Actual pi 1.0.4 runs with isolated profiles, dummy
credentials, and a checked loopback API. A scripted native tool response asks
pi to execute `bash pwd` and read `relative.txt`; the tools really execute.
The probe inspects the native transcript and system `cwd` section, not a
model's assertion about its directory.

## Results

The [native report](M1-native-pi1.0.4.json) records:

| Observation after launch from B | Result |
|---|---|
| Session ID / file | Unchanged |
| Prior history | Preserved |
| Native `bash pwd` | **A** |
| Relative read | **S3_FROM_A**, not B's sentinel |
| Latest native system cwd section | **A** |
| Original session header cwd | **A** |
| Native settlement | Exactly one for the resumed turn |

Private evidence: `build/spikes/M1-native-final-20261007/`, including A/B
transcripts and RPC captures. Three local API requests; **zero remote model
requests**. Tool choices and replies are scripted; cwd restoration and actual
filesystem/tool behavior are native. This does not depend on persuading a
provider to report its cwd correctly.

## Decision and implementation

Changing `cwd` while passing `--session` restores history **and the old
working directory**. Reporting B in shell context would not relocate native
relative tools. That mismatch is unsafe.

- The configuration default is now **split**: keep conversations anchored to
  their own root and select a separate conversation when the shell moves.
- Same-root resume remains supported, including canonical/symlink aliases.
- The pi adapter checks the native session header before spawning. It reads at
  most 64 KiB and compares canonical roots. Cross-root resume gets a clear
  `UNSUPPORTED` error with split/stay guidance, rather than silently using A.
- Malformed/unverifiable headers fail closed; an absent native file is left to
  pi's existing diagnostics. No generated header content is evaluated.
- `follow` remains a configuration policy for capable backends, **not** a
  claim of pi 1.0.4 support. Explicit `stay` keeps the original tool root.

Regressions cover root comparison, aliases, missing/unreadable/malformed files,
and refusal before child spawn. The native probe bypasses the new adapter guard
only to measure pi's actual behavior; normal adapter usage does not.
