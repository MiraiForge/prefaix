import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const REPOSITORY = "MiraiForge/prefaix";
const REPOSITORY_ID = "1384550147";
const WORKFLOW = ".github/workflows/ci.yml";
const ERROR = "Native matrix source identity could not be verified";
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
type Environment = Record<string, string | undefined>;
type Value = Record<string, unknown>;
export type GitFacts = {
  testedSha: string;
  treeSha: string;
  parents: string[];
};

function requireValue(value: unknown): asserts value {
  if (!value) throw new Error(ERROR);
}

function record(value: unknown): Value {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Value;
}

function sha(value: unknown): string {
  requireValue(
    typeof value === "string" &&
      /^[0-9a-f]{40}$/.test(value) &&
      !/^0+$/.test(value),
  );
  return value;
}

function identifier(value: unknown): string {
  requireValue(typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value));
  requireValue(Number.isSafeInteger(Number(value)));
  return value;
}

function numericIdentifier(value: unknown): string {
  requireValue(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
  );
  return identifier(String(value));
}

function refName(value: unknown): string {
  requireValue(
    typeof value === "string" && value.length > 0 && value.length <= 1024,
  );
  requireValue(
    [...value].every(
      (character) =>
        character.charCodeAt(0) > 32 &&
        character.charCodeAt(0) !== 127 &&
        !"~^:?*[\\".includes(character),
    ),
  );
  requireValue(
    !value.includes("..") && !value.includes("@{") && !value.includes("//"),
  );
  requireValue(
    value
      .split("/")
      .every(
        (part) => part && !part.startsWith(".") && !part.endsWith(".lock"),
      ),
  );
  requireValue(!value.endsWith(".") && value !== "@");
  return value;
}

export function readEvent(path: string): unknown {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = fstatSync(fd);
    requireValue(
      stats.isFile() && stats.size > 0 && stats.size <= MAX_EVENT_BYTES,
    );
    const bytes = Buffer.alloc(MAX_EVENT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    requireValue(size > 0 && size <= MAX_EVENT_BYTES);
    return JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

export function readGitFacts(workspace: string): GitFacts {
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "--no-replace-objects",
        "-C",
        workspace,
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          LC_ALL: "C",
        },
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  requireValue(
    realpathSync(git("rev-parse", "--show-toplevel")) ===
      realpathSync(workspace),
  );
  requireValue(
    [
      `https://github.com/${REPOSITORY}`,
      `https://github.com/${REPOSITORY}.git`,
    ].includes(git("config", "--get", "remote.origin.url")),
  );
  const testedSha = sha(git("rev-parse", "--verify", "HEAD^{commit}"));
  // Raw commit headers preserve merge parents even in checkout's shallow clone.
  const headers = git("cat-file", "commit", testedSha)
    .split("\n\n", 1)[0]!
    .split("\n");
  const trees = headers.filter((line) => line.startsWith("tree "));
  requireValue(trees.length === 1);
  const treeSha = sha(trees[0]!.slice(5));
  const parents = headers
    .filter((line) => line.startsWith("parent "))
    .map((line) => sha(line.slice(7)));
  requireValue(
    parents.length <= 16 && new Set(parents).size === parents.length,
  );
  requireValue(
    git("status", "--porcelain=v1", "--untracked-files=normal") === "",
  );
  return { testedSha, treeSha, parents };
}

export function captureIdentity(
  env: Environment,
  payload: unknown,
  facts: GitFacts,
) {
  requireValue(
    env.GITHUB_SERVER_URL === "https://github.com" &&
      env.GITHUB_REPOSITORY === REPOSITORY,
  );
  requireValue(identifier(env.GITHUB_REPOSITORY_ID) === REPOSITORY_ID);
  requireValue(
    env.RUNNER_OS === "macOS" && env.RUNNER_ENVIRONMENT === "github-hosted",
  );
  const runId = identifier(env.GITHUB_RUN_ID);
  const runAttempt = identifier(env.GITHUB_RUN_ATTEMPT);
  requireValue(Number(runAttempt) <= 999999);
  const checkRunId = identifier(env.PREFAIX_NATIVE_CHECK_RUN_ID);
  const ref = refName(env.GITHUB_REF);
  const testedSha = sha(facts.testedSha);
  const treeSha = sha(facts.treeSha);
  const parents = facts.parents.map(sha);
  requireValue(
    parents.length <= 16 && new Set(parents).size === parents.length,
  );
  requireValue(
    sha(env.GITHUB_SHA) === testedSha &&
      sha(env.GITHUB_WORKFLOW_SHA) === testedSha,
  );
  requireValue(
    env.PREFAIX_NATIVE_WORKFLOW_REPOSITORY === REPOSITORY &&
      env.PREFAIX_NATIVE_WORKFLOW_PATH === WORKFLOW,
  );
  requireValue(
    env.PREFAIX_NATIVE_WORKFLOW_REF === `${REPOSITORY}/${WORKFLOW}@${ref}`,
  );
  requireValue(sha(env.PREFAIX_NATIVE_WORKFLOW_SHA) === testedSha);
  requireValue(
    typeof env.GITHUB_WORKFLOW === "string" &&
      env.GITHUB_WORKFLOW.length > 0 &&
      env.GITHUB_WORKFLOW.length <= 128,
  );
  const callerPrefix = `${REPOSITORY}/.github/workflows/`;
  requireValue(
    typeof env.GITHUB_WORKFLOW_REF === "string" &&
      env.GITHUB_WORKFLOW_REF.startsWith(callerPrefix) &&
      env.GITHUB_WORKFLOW_REF.endsWith(`@${ref}`),
  );
  const callerPath = env.GITHUB_WORKFLOW_REF.slice(
    callerPrefix.length,
    -(ref.length + 1),
  );
  requireValue(/^[A-Za-z0-9_.-]+\.ya?ml$/.test(callerPath));

  requireValue(
    env.PREFAIX_NATIVE_MATRIX && env.PREFAIX_NATIVE_MATRIX.length <= 1024,
  );
  const matrix = record(JSON.parse(env.PREFAIX_NATIVE_MATRIX));
  const job = env.GITHUB_JOB;
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
    requireValue(matrix.os === "macos-latest");
    requireValue(
      (matrix.bash === "4.4" && matrix.fish === "3.6.4") ||
        (matrix.bash === "5.2" && matrix.fish === "4.0.2"),
    );
    lane = `shells-bash${String(matrix.bash)}-fish${String(matrix.fish)}`;
  }
  requireValue(
    env.PREFAIX_NATIVE_INPUTS && env.PREFAIX_NATIVE_INPUTS.length <= 1024,
  );
  const inputs = record(JSON.parse(env.PREFAIX_NATIVE_INPUTS));
  requireValue(
    Object.entries(inputs).every(
      ([key, value]) =>
        ["flake_gate", "pi_smoke"].includes(key) && typeof value === "boolean",
    ),
  );
  const choices = {
    flakeGate: inputs.flake_gate === true,
    piSmoke: inputs.pi_smoke === true,
  };
  const event = record(payload);
  const repository = record(event.repository);
  requireValue(
    repository.full_name === REPOSITORY &&
      numericIdentifier(repository.id) === REPOSITORY_ID,
  );
  let sourceSha = testedSha;
  let baseSha: string | null = null;
  let pullRequest: number | null = null;
  let headRepository = REPOSITORY;
  let headRepositoryId = REPOSITORY_ID;
  let sourceBranch: string | null = null;
  let baseBranch: string | null = null;
  let eventAfter: string | null = null;
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    requireValue(
      ["opened", "reopened", "synchronize"].includes(String(event.action)),
    );
    const pr = record(event.pull_request);
    pullRequest = Number(numericIdentifier(event.number));
    requireValue(
      pullRequest <= 2147483647 &&
        numericIdentifier(pr.number) === String(pullRequest),
    );
    requireValue(
      pr.state === "open" &&
        pr.merged === false &&
        ref === `refs/pull/${pullRequest}/merge`,
    );
    const head = record(pr.head);
    const base = record(pr.base);
    const headRepo = record(head.repo);
    const baseRepo = record(base.repo);
    requireValue(
      baseRepo.full_name === REPOSITORY &&
        numericIdentifier(baseRepo.id) === REPOSITORY_ID,
    );
    requireValue(
      typeof headRepo.full_name === "string" &&
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(headRepo.full_name),
    );
    headRepository = headRepo.full_name;
    headRepositoryId = numericIdentifier(headRepo.id);
    requireValue(
      (headRepository === REPOSITORY) === (headRepositoryId === REPOSITORY_ID),
    );
    sourceBranch = refName(head.ref);
    baseBranch = refName(base.ref);
    requireValue(
      env.GITHUB_HEAD_REF === sourceBranch &&
        env.GITHUB_BASE_REF === baseBranch,
    );
    sourceSha = sha(head.sha);
    baseSha = sha(base.sha);
    requireValue(new Set([testedSha, sourceSha, baseSha]).size === 3);
    requireValue(
      parents.length === 2 &&
        parents[0] === baseSha &&
        parents[1] === sourceSha,
    );
  } else {
    requireValue(ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/"));
    if (env.GITHUB_EVENT_NAME === "push") {
      requireValue(event.ref === ref && event.deleted === false);
      eventAfter = sha(event.after);
      // Annotated tags can identify a tag object; the consumer must resolve it.
      if (ref.startsWith("refs/heads/")) requireValue(eventAfter === testedSha);
    } else {
      requireValue(env.GITHUB_EVENT_NAME === "workflow_dispatch");
      requireValue(
        event.ref === ref ||
          event.ref === ref.replace(/^refs\/(heads|tags)\//, ""),
      );
    }
  }
  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    event: env.GITHUB_EVENT_NAME,
    ref,
    runId,
    runAttempt,
    checkRunId,
    job,
    lane,
    matrix,
    choices,
    stabilityRequired:
      choices.flakeGate || ref.toLowerCase().startsWith("refs/tags/v"),
    callerWorkflowName: env.GITHUB_WORKFLOW,
    callerWorkflowRef: env.GITHUB_WORKFLOW_REF,
    callerWorkflowSha: testedSha,
    jobWorkflowRef: env.PREFAIX_NATIVE_WORKFLOW_REF,
    jobWorkflowSha: testedSha,
    sourceSha,
    baseSha,
    testedSha,
    treeSha,
    parents,
    pullRequest,
    headRepository,
    headRepositoryId,
    sourceBranch,
    baseBranch,
    eventAfter,
  };
}

export function capture(env: Environment) {
  requireValue(process.platform === "darwin");
  requireValue(
    env.GITHUB_WORKSPACE && env.GITHUB_EVENT_PATH && env.RUNNER_TEMP,
  );
  const evidence = captureIdentity(
    env,
    readEvent(env.GITHUB_EVENT_PATH),
    readGitFacts(env.GITHUB_WORKSPACE),
  );
  const json = `${JSON.stringify(evidence)}\n`;
  requireValue(Buffer.byteLength(json) <= 8192);
  const directory = join(
    env.RUNNER_TEMP,
    `prefaix-native-${evidence.runId}-${evidence.runAttempt}-${evidence.checkRunId}`,
  );
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "source.json"), json, {
    flag: "wx",
    mode: 0o400,
  });
}

if (import.meta.main) {
  try {
    capture(process.env);
    console.log("Native matrix source evidence captured");
  } catch {
    console.error(ERROR);
    process.exitCode = 1;
  }
}
