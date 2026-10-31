import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitFacts } from "./native-source.js";

// Node executes the reviewed TypeScript helper directly, before dependencies
// from the selected source have been installed or executed.
const { readEvent, readGitFacts } = (await import(
  new URL("./native-source.ts", import.meta.url).href
)) as typeof import("./native-source.js");

const REPOSITORY = "MiraiForge/prefaix";
const REPOSITORY_ID = 1384550147;
const WORKFLOW = ".github/workflows/buildkite-native.yml";
const ERROR = "Buildkite native source identity could not be verified";
type Environment = Record<string, string | undefined>;
type RecordValue = Record<string, unknown>;

function requireValue(value: unknown): asserts value {
  if (!value) throw new Error(ERROR);
}

function record(value: unknown): RecordValue {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  return value as RecordValue;
}

function sha(value: unknown): string {
  requireValue(typeof value === "string" && /^[0-9a-f]{40}$/.test(value));
  requireValue(!/^0+$/.test(value));
  return value;
}

function uuid(value: unknown): string {
  requireValue(
    typeof value === "string" &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value),
  );
  return value;
}

function identifier(value: unknown): string {
  requireValue(typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value));
  requireValue(Number.isSafeInteger(Number(value)));
  return value;
}

function selectedRef(value: unknown): string {
  requireValue(
    typeof value === "string" &&
      value.length <= 1024 &&
      /^(refs\/heads\/|refs\/tags\/).+/.test(value),
  );
  requireValue(
    [...value].every(
      (character) =>
        character.charCodeAt(0) > 32 &&
        character.charCodeAt(0) !== 127 &&
        !"~^:?*[\\".includes(character) &&
        !/\s/u.test(character),
    ) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith(".") &&
      value
        .split("/")
        .every(
          (part) => part && !part.startsWith(".") && !part.endsWith(".lock"),
        ),
  );
  return value;
}

export function captureBuildkiteIdentity(
  env: Environment,
  payload: unknown,
  facts: GitFacts,
  control: GitFacts,
) {
  requireValue(
    env.GITHUB_SERVER_URL === "https://github.com" &&
      env.GITHUB_REPOSITORY === REPOSITORY &&
      env.GITHUB_REPOSITORY_ID === String(REPOSITORY_ID) &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_WORKFLOW === "Buildkite native CI" &&
      env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${WORKFLOW}@refs/heads/main` &&
      env.RUNNER_OS === "macOS" &&
      env.RUNNER_ENVIRONMENT === "github-hosted",
  );
  const workflowSha = sha(env.GITHUB_WORKFLOW_SHA);
  requireValue(
    sha(env.GITHUB_SHA) === workflowSha && control.testedSha === workflowSha,
  );
  const event = record(payload);
  const repository = record(event.repository);
  requireValue(
    repository.full_name === REPOSITORY && repository.id === REPOSITORY_ID,
  );
  requireValue(
    (event.ref === "main" || event.ref === "refs/heads/main") &&
      !event.pull_request,
  );
  requireValue(
    env.PREFAIX_NATIVE_INPUTS && env.PREFAIX_NATIVE_INPUTS.length <= 4096,
  );
  const inputs = record(JSON.parse(env.PREFAIX_NATIVE_INPUTS));
  const expectedKeys = [
    "build_id",
    "flake_gate",
    "pi_smoke",
    "request_id",
    "source_digest",
    "source_ref",
    "source_sha",
  ].sort();
  requireValue(
    JSON.stringify(Object.keys(inputs).sort()) === JSON.stringify(expectedKeys),
  );
  const rawInputs = record(event.inputs);
  requireValue(
    JSON.stringify(Object.keys(rawInputs).sort()) ===
      JSON.stringify(expectedKeys),
  );
  requireValue(
    expectedKeys.every((key) => rawInputs[key] === String(inputs[key])),
  );
  requireValue(
    typeof inputs.flake_gate === "boolean" &&
      typeof inputs.pi_smoke === "boolean",
  );
  const sourceSha = sha(inputs.source_sha);
  const ref = selectedRef(inputs.source_ref);
  requireValue(sourceSha === sha(facts.testedSha));
  requireValue(
    typeof inputs.source_digest === "string" &&
      /^[0-9a-f]{64}$/.test(inputs.source_digest),
  );
  requireValue(
    facts.parents.length <= 16 &&
      new Set(facts.parents).size === facts.parents.length,
  );
  facts.parents.forEach(sha);
  const job = env.GITHUB_JOB;
  requireValue(
    env.PREFAIX_NATIVE_MATRIX && env.PREFAIX_NATIVE_MATRIX.length <= 1024,
  );
  const matrix = record(JSON.parse(env.PREFAIX_NATIVE_MATRIX));
  let lane: string;
  if (job === "check" || job === "performance") {
    requireValue(Object.keys(matrix).sort().join(",") === "node,os");
    requireValue(matrix.os === (job === "check" ? "macos-latest" : "macos-15"));
    requireValue(
      typeof matrix.node === "number" && [22, 24, 26].includes(matrix.node),
    );
    lane = `${job}-node${matrix.node}`;
  } else {
    requireValue(
      job === "shell-versions" &&
        Object.keys(matrix).sort().join(",") === "bash,fish,os",
    );
    requireValue(
      matrix.os === "macos-latest" &&
        ((matrix.bash === "4.4" && matrix.fish === "3.6.4") ||
          (matrix.bash === "5.2" && matrix.fish === "4.0.2")),
    );
    lane = `shells-bash${matrix.bash}-fish${matrix.fish}`;
  }
  return {
    schemaVersion: 1,
    policy: "prefaix-buildkite-native-v1",
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    requestId: uuid(inputs.request_id),
    buildId: uuid(inputs.build_id),
    sourceDigest: inputs.source_digest,
    sourceSha,
    testedSha: facts.testedSha,
    treeSha: sha(facts.treeSha),
    parents: facts.parents,
    ref,
    choices: { flakeGate: inputs.flake_gate, piSmoke: inputs.pi_smoke },
    stabilityRequired:
      inputs.flake_gate || ref.toLowerCase().startsWith("refs/tags/v"),
    workflowSha,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    runId: identifier(env.GITHUB_RUN_ID),
    runAttempt: identifier(env.GITHUB_RUN_ATTEMPT),
    checkRunId: identifier(env.PREFAIX_NATIVE_CHECK_RUN_ID),
    job,
    lane,
    matrix,
  };
}

export function captureBuildkite(env: Environment) {
  requireValue(process.platform === "darwin");
  requireValue(
    env.GITHUB_WORKSPACE && env.GITHUB_EVENT_PATH && env.RUNNER_TEMP,
  );
  const root = realpathSync(env.GITHUB_WORKSPACE);
  const source = realpathSync(join(root, "source"));
  const control = realpathSync(join(root, "control"));
  requireValue(
    source === join(root, "source") && control === join(root, "control"),
  );
  const evidence = captureBuildkiteIdentity(
    env,
    readEvent(env.GITHUB_EVENT_PATH),
    readGitFacts(source),
    readGitFacts(control),
  );
  const json = `${JSON.stringify(evidence)}\n`;
  requireValue(Buffer.byteLength(json) <= 8192);
  const directory = join(
    env.RUNNER_TEMP,
    `prefaix-buildkite-native-${evidence.runId}-${evidence.runAttempt}-${evidence.checkRunId}`,
  );
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "source.json"), json, {
    flag: "wx",
    mode: 0o400,
  });
}

if (import.meta.main) {
  try {
    captureBuildkite(process.env);
    console.log("Buildkite native source evidence captured");
  } catch {
    console.error(ERROR);
    process.exitCode = 1;
  }
}
