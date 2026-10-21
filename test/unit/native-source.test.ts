import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  capture,
  captureIdentity,
  readEvent,
  type GitFacts,
} from "../../scripts/ci/native-source.js";

const repository = { full_name: "MiraiForge/prefaix", id: 1384550147 };
const source = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);
const tree = "d".repeat(40);
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

function fixture() {
  const ref = "refs/heads/main";
  const workflow = `MiraiForge/prefaix/.github/workflows/ci.yml@${ref}`;
  const env: Record<string, string> = {
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: repository.full_name,
    GITHUB_REPOSITORY_ID: String(repository.id),
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_JOB: "check",
    GITHUB_SHA: source,
    GITHUB_WORKFLOW_SHA: source,
    GITHUB_WORKFLOW: "CI",
    GITHUB_WORKFLOW_REF: workflow,
    GITHUB_REF: ref,
    GITHUB_EVENT_NAME: "push",
    RUNNER_OS: "macOS",
    RUNNER_ENVIRONMENT: "github-hosted",
    PREFAIX_NATIVE_CHECK_RUN_ID: "98765",
    PREFAIX_NATIVE_WORKFLOW_REPOSITORY: repository.full_name,
    PREFAIX_NATIVE_WORKFLOW_PATH: ".github/workflows/ci.yml",
    PREFAIX_NATIVE_WORKFLOW_REF: workflow,
    PREFAIX_NATIVE_WORKFLOW_SHA: source,
    PREFAIX_NATIVE_MATRIX: JSON.stringify({ os: "macos-latest", node: 24 }),
    PREFAIX_NATIVE_INPUTS: "{}",
  };
  const event = { repository, ref, after: source, deleted: false };
  const facts: GitFacts = { testedSha: source, treeSha: tree, parents: [base] };
  return { env, event, facts };
}

function pullRequest(fork = false) {
  const x = fixture();
  const ref = "refs/pull/8/merge";
  Object.assign(x.env, {
    GITHUB_REF: ref,
    GITHUB_SHA: merge,
    GITHUB_WORKFLOW_SHA: merge,
    GITHUB_WORKFLOW_REF: `MiraiForge/prefaix/.github/workflows/ci.yml@${ref}`,
    PREFAIX_NATIVE_WORKFLOW_REF: `MiraiForge/prefaix/.github/workflows/ci.yml@${ref}`,
    PREFAIX_NATIVE_WORKFLOW_SHA: merge,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_HEAD_REF: "feature/native",
    GITHUB_BASE_REF: "release/next",
  });
  const event = {
    repository,
    number: 8,
    action: "synchronize",
    pull_request: {
      number: 8,
      state: "open",
      merged: false,
      head: {
        sha: source,
        ref: "feature/native",
        repo: fork ? { full_name: "contributor/prefaix", id: 222 } : repository,
      },
      base: { sha: base, ref: "release/next", repo: repository },
    },
  };
  return {
    env: x.env,
    event,
    facts: { testedSha: merge, treeSha: tree, parents: [base, source] },
  };
}

function setRef(env: Record<string, string>, ref: string) {
  env.GITHUB_REF = ref;
  env.GITHUB_WORKFLOW_REF = `MiraiForge/prefaix/.github/workflows/ci.yml@${ref}`;
  env.PREFAIX_NATIVE_WORKFLOW_REF = env.GITHUB_WORKFLOW_REF;
}

describe("native matrix source evidence", () => {
  it("records actual source, tree, attempt and job identity without claiming success", () => {
    const x = fixture();
    const evidence = captureIdentity(x.env, x.event, x.facts);
    expect(evidence).toMatchObject({
      sourceSha: source,
      testedSha: source,
      treeSha: tree,
      parents: [base],
      runAttempt: "2",
      checkRunId: "98765",
      lane: "check-node24",
      stabilityRequired: false,
      choices: { flakeGate: false, piSmoke: false },
    });
    expect(evidence).not.toHaveProperty("success");
    expect(evidence).not.toHaveProperty("token");
  });

  it.each([22, 24, 26])("binds both native Node %s lanes", (node) => {
    for (const job of ["check", "performance"]) {
      const x = fixture();
      x.env.GITHUB_JOB = job;
      x.env.PREFAIX_NATIVE_MATRIX = JSON.stringify({
        os: job === "check" ? "macos-latest" : "macos-15",
        node,
      });
      expect(captureIdentity(x.env, x.event, x.facts).lane).toBe(
        `${job}-node${node}`,
      );
    }
  });

  it.each([
    ["4.4", "3.6.4"],
    ["5.2", "4.0.2"],
  ])("binds the native bash %s / fish %s lane", (bash, fish) => {
    const x = fixture();
    x.env.GITHUB_JOB = "shell-versions";
    x.env.PREFAIX_NATIVE_MATRIX = JSON.stringify({
      os: "macos-latest",
      bash,
      fish,
    });
    expect(captureIdentity(x.env, x.event, x.facts).lane).toBe(
      `shells-bash${bash}-fish${fish}`,
    );
  });

  it.each([false, true])(
    "captures PR merge parents and non-main base (fork=%s)",
    (fork) => {
      const x = pullRequest(fork);
      expect(captureIdentity(x.env, x.event, x.facts)).toMatchObject({
        sourceSha: source,
        baseSha: base,
        testedSha: merge,
        parents: [base, source],
        pullRequest: 8,
        sourceBranch: "feature/native",
        baseBranch: "release/next",
        headRepository: fork ? "contributor/prefaix" : repository.full_name,
      });
    },
  );

  it("keeps a release caller distinct from the called CI workflow", () => {
    const x = fixture();
    setRef(x.env, "refs/tags/v0.1.0");
    x.env.GITHUB_WORKFLOW = "Release";
    x.env.GITHUB_WORKFLOW_REF =
      "MiraiForge/prefaix/.github/workflows/release.yml@refs/tags/v0.1.0";
    x.event.ref = x.env.GITHUB_REF!;
    // A tag object may differ from its peeled checkout commit.
    x.event.after = "e".repeat(40);
    expect(captureIdentity(x.env, x.event, x.facts)).toMatchObject({
      callerWorkflowName: "Release",
      callerWorkflowRef: x.env.GITHUB_WORKFLOW_REF,
      jobWorkflowRef: x.env.PREFAIX_NATIVE_WORKFLOW_REF,
      eventAfter: "e".repeat(40),
      testedSha: source,
      stabilityRequired: true,
    });
  });

  it.each([
    ["refs/tags/v1", true],
    ["refs/tags/V1", true],
    ["refs/tags/v/path", true],
    ["refs/tags/V/path", true],
    ["refs/heads/v1", false],
    ["refs/tags/release", false],
  ] as const)("preserves conditional stability for %s", (ref, expected) => {
    const x = fixture();
    setRef(x.env, ref);
    x.env.GITHUB_EVENT_NAME = "workflow_dispatch";
    x.event.ref = ref.replace(/^refs\/(heads|tags)\//, "");
    x.env.PREFAIX_NATIVE_INPUTS = '{"flake_gate":false,"pi_smoke":true}';
    const evidence = captureIdentity(x.env, x.event, x.facts);
    expect(evidence.stabilityRequired).toBe(expected);
    expect(evidence.choices.piSmoke).toBe(true);
  });

  it("requires stability for an explicit boolean choice on a branch", () => {
    const x = fixture();
    x.env.PREFAIX_NATIVE_INPUTS = '{"flake_gate":true,"pi_smoke":false}';
    expect(captureIdentity(x.env, x.event, x.facts).stabilityRequired).toBe(
      true,
    );
  });

  it.each([
    ["GITHUB_SHA", base],
    ["GITHUB_WORKFLOW_SHA", base],
    ["PREFAIX_NATIVE_WORKFLOW_SHA", base],
    ["GITHUB_REPOSITORY_ID", "222"],
    ["GITHUB_REPOSITORY", "other/prefaix"],
    ["GITHUB_RUN_ID", "0"],
    ["GITHUB_RUN_ATTEMPT", "1000000"],
    ["PREFAIX_NATIVE_CHECK_RUN_ID", "1e3"],
    ["PREFAIX_NATIVE_CHECK_RUN_ID", "9007199254740992"],
    ["RUNNER_OS", "Linux"],
    ["RUNNER_ENVIRONMENT", "self-hosted"],
    ["GITHUB_SERVER_URL", "https://example.com"],
    ["GITHUB_JOB", "required"],
    ["PREFAIX_NATIVE_WORKFLOW_PATH", ".github/workflows/release.yml"],
    ["PREFAIX_NATIVE_WORKFLOW_REPOSITORY", "other/prefaix"],
    [
      "GITHUB_WORKFLOW_REF",
      "other/prefaix/.github/workflows/ci.yml@refs/heads/main",
    ],
    ["PREFAIX_NATIVE_MATRIX", '{"os":"ubuntu-latest","node":24}'],
    ["PREFAIX_NATIVE_MATRIX", '{"os":"macos-latest","node":"24"}'],
    ["PREFAIX_NATIVE_MATRIX", '{"os":"macos-latest","node":24,"extra":1}'],
    ["PREFAIX_NATIVE_INPUTS", '{"flake_gate":"false"}'],
    ["PREFAIX_NATIVE_INPUTS", '{"unexpected":false}'],
    ["PREFAIX_NATIVE_INPUTS", "[]"],
    ["GITHUB_EVENT_NAME", "pull_request_target"],
  ])("rejects invalid %s = %s", (key, value) => {
    const x = fixture();
    x.env[key] = value;
    expect(() => captureIdentity(x.env, x.event, x.facts)).toThrow();
  });

  it.each([[source, base], [base], [base, source, base]])(
    "rejects incorrect PR merge parents %j",
    (...parents) => {
      const x = pullRequest();
      x.facts.parents = parents;
      expect(() => captureIdentity(x.env, x.event, x.facts)).toThrow();
    },
  );

  it("rejects source movement, repository identity changes and a closed PR", () => {
    const changes = [
      (x: ReturnType<typeof pullRequest>) => {
        x.event.pull_request.head.sha = "f".repeat(40);
      },
      (x: ReturnType<typeof pullRequest>) => {
        x.event.pull_request.head.repo.id = 999;
      },
      (x: ReturnType<typeof pullRequest>) => {
        x.event.pull_request.base.repo = { ...repository, id: 999 };
      },
      (x: ReturnType<typeof pullRequest>) => {
        x.event.pull_request.state = "closed";
      },
      (x: ReturnType<typeof pullRequest>) => {
        x.env.GITHUB_BASE_REF = "main";
      },
    ];
    for (const change of changes) {
      const x = pullRequest();
      // Fixtures must not mutate the shared repository object.
      x.event.pull_request.head.repo = { ...x.event.pull_request.head.repo };
      change(x);
      expect(() => captureIdentity(x.env, x.event, x.facts)).toThrow();
    }
  });

  it.each([
    "refs/heads/../main",
    "refs/heads/branch.lock",
    "refs/heads/a\nb",
    "refs/heads/a@{b",
    "refs/tags//v1",
  ])("rejects malformed ref %j", (ref) => {
    const x = fixture();
    setRef(x.env, ref);
    x.event.ref = ref;
    expect(() => captureIdentity(x.env, x.event, x.facts)).toThrow();
  });

  it("rejects deletion or a push/checkout mismatch", () => {
    const x = fixture();
    expect(() =>
      captureIdentity(x.env, { ...x.event, deleted: true }, x.facts),
    ).toThrow();
    expect(() =>
      captureIdentity(x.env, { ...x.event, after: base }, x.facts),
    ).toThrow();
  });

  it("reads bounded regular event files and rejects symlinks and directories", () => {
    const root = mkdtempSync(join(tmpdir(), "prefaix-native-event-"));
    roots.push(root);
    const file = join(root, "event.json");
    writeFileSync(file, JSON.stringify(fixture().event));
    expect(readEvent(file)).toEqual(fixture().event);
    const link = join(root, "link");
    symlinkSync(file, link);
    expect(() => readEvent(link)).toThrow();
    const directory = join(root, "directory");
    mkdirSync(directory);
    expect(() => readEvent(directory)).toThrow();
    writeFileSync(file, "");
    expect(() => readEvent(file)).toThrow();
    writeFileSync(file, "x".repeat(2 * 1024 * 1024 + 1));
    expect(() => readEvent(file)).toThrow();
  });

  it.skipIf(process.platform === "darwin")(
    "refuses capture on a Linux or Windows host",
    () => {
      expect(() => capture(fixture().env)).toThrow();
    },
  );
});
