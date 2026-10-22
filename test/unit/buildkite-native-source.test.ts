import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { captureBuildkiteIdentity } from "../../scripts/ci/buildkite-native-source.js";

const sourceSha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const facts = {
  testedSha: sourceSha,
  treeSha: "c".repeat(40),
  parents: ["d".repeat(40)],
};
const control = { ...facts, testedSha: workflowSha };
const inputs = {
  request_id: "11111111-1111-1111-1111-111111111111",
  build_id: "22222222-2222-2222-2222-222222222222",
  source_sha: sourceSha,
  source_ref: "refs/heads/feature/test",
  source_digest: "e".repeat(64),
  flake_gate: false,
  pi_smoke: false,
};
const env = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "MiraiForge/prefaix",
  GITHUB_REPOSITORY_ID: "1384550147",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: workflowSha,
  GITHUB_WORKFLOW_SHA: workflowSha,
  GITHUB_WORKFLOW: "Buildkite native CI",
  GITHUB_WORKFLOW_REF:
    "MiraiForge/prefaix/.github/workflows/buildkite-native.yml@refs/heads/main",
  RUNNER_OS: "macOS",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
  PREFAIX_NATIVE_CHECK_RUN_ID: "456",
  GITHUB_JOB: "check",
  PREFAIX_NATIVE_MATRIX: JSON.stringify({ os: "macos-latest", node: 22 }),
  PREFAIX_NATIVE_INPUTS: JSON.stringify(inputs),
};
function event(value = inputs) {
  return {
    repository: { full_name: "MiraiForge/prefaix", id: 1384550147 },
    ref: "main",
    inputs: Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, String(val)]),
    ),
  };
}

describe("Buildkite native source evidence", () => {
  it("binds a different tested commit to the reviewed workflow, request and parent build", () => {
    const value = captureBuildkiteIdentity(env, event(), facts, control);
    expect(value).toMatchObject({
      sourceSha,
      testedSha: sourceSha,
      workflowSha,
      requestId: inputs.request_id,
      buildId: inputs.build_id,
      sourceDigest: inputs.source_digest,
      ref: inputs.source_ref,
      runId: "123",
      runAttempt: "2",
      checkRunId: "456",
      lane: "check-node22",
    });
    expect(value.sourceSha).not.toBe(value.workflowSha);
  });

  it("preserves every native matrix and manual choice combination", () => {
    const lanes = [
      ...["check", "performance"].flatMap((job) =>
        [22, 24, 26].map((node) => ({
          job,
          matrix: { os: job === "check" ? "macos-latest" : "macos-15", node },
        })),
      ),
      ...[
        ["4.4", "3.6.4"],
        ["5.2", "4.0.2"],
      ].map(([bash, fish]) => ({
        job: "shell-versions",
        matrix: { os: "macos-latest", bash, fish },
      })),
    ];
    for (const { job, matrix } of lanes) {
      for (const flake of [true, false])
        for (const pi of [true, false]) {
          const value = { ...inputs, flake_gate: flake, pi_smoke: pi };
          const actual = captureBuildkiteIdentity(
            {
              ...env,
              GITHUB_JOB: job,
              PREFAIX_NATIVE_MATRIX: JSON.stringify(matrix),
              PREFAIX_NATIVE_INPUTS: JSON.stringify(value),
            },
            event(value),
            facts,
            control,
          );
          expect(actual.choices).toEqual({ flakeGate: flake, piSmoke: pi });
          expect(actual.stabilityRequired).toBe(flake);
        }
    }
    const tag = { ...inputs, source_ref: "refs/tags/v0.1.0" };
    expect(
      captureBuildkiteIdentity(
        { ...env, PREFAIX_NATIVE_INPUTS: JSON.stringify(tag) },
        event(tag),
        facts,
        control,
      ).stabilityRequired,
    ).toBe(true);
  });

  it("accepts both GitHub main ref spellings and rejects every other dispatch ref", () => {
    for (const ref of ["main", "refs/heads/main"])
      expect(
        captureBuildkiteIdentity(env, { ...event(), ref }, facts, control)
          .workflowSha,
      ).toBe(workflowSha);
    for (const ref of [
      "feature/test",
      "refs/heads/feature/test",
      "refs/tags/main",
    ])
      expect(() =>
        captureBuildkiteIdentity(env, { ...event(), ref }, facts, control),
      ).toThrow();
  });

  it("denies wrong workflow, repository, runner, source, or execution identities", () => {
    for (const change of [
      { GITHUB_EVENT_NAME: "pull_request_target" },
      { GITHUB_REF: "refs/tags/v1" },
      { GITHUB_REPOSITORY: "outside/prefaix" },
      { GITHUB_REPOSITORY_ID: "1" },
      { GITHUB_WORKFLOW_SHA: sourceSha },
      { GITHUB_SHA: sourceSha },
      {
        GITHUB_WORKFLOW_REF:
          "MiraiForge/prefaix/.github/workflows/ci.yml@refs/heads/main",
      },
      { RUNNER_OS: "Linux" },
      { RUNNER_ENVIRONMENT: "self-hosted" },
      { GITHUB_RUN_ATTEMPT: "0" },
      { PREFAIX_NATIVE_CHECK_RUN_ID: "01" },
      { GITHUB_RUN_ID: "9007199254740992" },
      { GITHUB_JOB: "pi-smoke" },
      { PREFAIX_NATIVE_MATRIX: '{"os":"ubuntu-latest","node":22}' },
    ])
      expect(() =>
        captureBuildkiteIdentity(
          { ...env, ...change },
          event(),
          facts,
          control,
        ),
      ).toThrow();
    expect(() =>
      captureBuildkiteIdentity(
        env,
        event(),
        { ...facts, testedSha: workflowSha },
        control,
      ),
    ).toThrow();
    expect(() =>
      captureBuildkiteIdentity(
        env,
        { ...event(), repository: { id: 1, full_name: "MiraiForge/prefaix" } },
        facts,
        control,
      ),
    ).toThrow();
    expect(() =>
      captureBuildkiteIdentity(
        env,
        { ...event(), pull_request: {} },
        facts,
        control,
      ),
    ).toThrow();
  });

  it("denies ambiguous inputs, event mismatch, foreign refs and refspecs", () => {
    for (const change of [
      { flake_gate: "true" },
      { pi_smoke: 1 },
      { source_sha: "HEAD" },
      { source_digest: "invalid" },
      { request_id: "another" },
      { build_id: "another" },
      { source_ref: "refs/pull/1/head" },
      { source_ref: "main" },
      { source_ref: "refs/heads/main:refs/heads/other" },
      { source_ref: "refs/heads/a\nb" },
      { source_ref: "refs/heads/../main" },
      { source_ref: "refs/tags/name.lock" },
      { source_ref: "refs/heads/a//b" },
      { source_ref: "refs/heads/a@{1}" },
      { source_ref: "refs/heads/a\\b" },
      { source_ref: "refs/heads/a." },
      { extra: "untrusted" },
    ]) {
      const value = { ...inputs, ...change };
      expect(() =>
        captureBuildkiteIdentity(
          { ...env, PREFAIX_NATIVE_INPUTS: JSON.stringify(value) },
          {
            ...event(),
            inputs: Object.fromEntries(
              Object.entries(value).map(([key, val]) => [key, String(val)]),
            ),
          },
          facts,
          control,
        ),
      ).toThrow();
    }
    expect(() =>
      captureBuildkiteIdentity(
        env,
        event({ ...inputs, flake_gate: true }),
        facts,
        control,
      ),
    ).toThrow();
  });
});

describe("native-only workflow boundary", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/buildkite-native.yml", import.meta.url),
    "utf8",
  );
  it("runs the eight macOS lanes with original budgets and no Linux/publisher job", () => {
    expect(
      [...workflow.split("\njobs:\n")[1]!.matchAll(/^ {2}([\w-]+):$/gm)].map(
        (m) => m[1],
      ),
    ).toEqual(["check", "performance", "shell-versions"]);
    expect(workflow.match(/timeout-minutes: 20/g)).toHaveLength(2);
    expect(workflow.match(/timeout-minutes: 90/g)).toHaveLength(1);
    expect(workflow).toContain("os: [macos-latest]");
    expect(workflow).toContain("os: [macos-15]");
    expect(workflow.match(/node: \[22, 24, 26\]/g)).toHaveLength(2);
    expect(workflow.match(/- os: macos-latest/g)).toHaveLength(2);
    expect(workflow).not.toMatch(
      /ubuntu|self-hosted|id-token:|packages:|npm publish|workflow_call:|pull_request:| {2}push:/,
    );
  });
  it("captures source with the reviewed helper before dependencies and separates control/source checkouts", () => {
    for (const block of workflow
      .split(/^ {2}(?:check|performance|shell-versions):$/m)
      .slice(1)) {
      expect(block).toContain("ref: ${{ github.workflow_sha }}");
      expect(block).toContain("ref: ${{ inputs.source_sha }}");
      expect(block).toContain("working-directory: source");
      expect(block).toContain(
        'node "$GITHUB_WORKSPACE/control/scripts/ci/buildkite-native-source.ts"',
      );
      expect(block.indexOf("Preserve Buildkite native source")).toBeLessThan(
        block.indexOf("oven-sh/setup-bun@"),
      );
      expect(block).toContain("overwrite: false");
      expect(block.match(/persist-credentials: false/g)).toHaveLength(2);
    }
    expect(workflow).toContain("startsWith(inputs.source_ref, 'refs/tags/v')");
    expect(workflow).toContain("path: source/build/flake");
  });
});
