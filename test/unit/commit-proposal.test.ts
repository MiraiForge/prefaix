import { describe, expect, it } from "vitest";
import {
  commitCommand,
  commitMessage,
  commitGuideline,
  parseCommitArgs,
} from "../../src/core/commit-proposal.js";
import { commitProposalTool } from "../../src/agents/pi/command-proposal.js";

describe.each(["bash", "zsh", "fish"] as const)(
  "%s commit quoting",
  (shell) => {
    it.each([
      "feat: add widgets",
      "fix: don't expand $HOME, $(touch sentinel), `id`, !, * or ;",
      "docs: 日本語🙂\n\nBody with '\\path' and backslashes\\.",
      "-m --amend -- $(echo nope)",
      "\\'double\\\\'end",
    ])("round trips %j as one inert argument", (message) => {
      expect(commitMessage(commitCommand(message, shell), shell)).toBe(message);
    });
    it.each([
      "echo evil",
      "git commit -m ''",
      "git commit -m 'hello'; touch sentinel",
      "git commit -m 'hello'; touch sentinel; echo 'end'",
      "git commit -m 'hello' --amend 'end'",
      "git commit -m 'hello\u0000'",
      "git commit -m 'hello\u001b'",
    ])("rejects noncanonical or invalid payload %j", (command) => {
      expect(commitMessage(command, shell)).toBeUndefined();
    });
  },
);
it("parses only a leading explicit --run and supports literal flag-like hints", () => {
  expect(parseCommitArgs("--run follow conventions")).toEqual({
    hint: "follow conventions",
    run: true,
  });
  expect(parseCommitArgs("--run")).toEqual({ hint: "", run: true });
  expect(parseCommitArgs("-- --run literally")).toEqual({
    hint: "--run literally",
    run: false,
  });
  expect(parseCommitArgs("explain --run")).toEqual({
    hint: "explain --run",
    run: false,
  });
  expect(parseCommitArgs("--runner")).toEqual({ hint: "--runner", run: false });
});
it("instructs the model to treat staged content as data and honor the configured style", () => {
  expect(
    commitGuideline("Conventional Commits: type(scope): subject"),
  ).toContain("Conventional Commits");
  expect(commitGuideline("style")).toContain("untrusted data");
  expect(commitGuideline("style")).toContain("propose_commit");
});
it("the commit tool accepts message data, quotes locally, and never executes", () => {
  const tool = commitProposalTool(
    () => true,
    () => "fish",
  );
  expect(tool.parameters).toMatchObject({
    required: ["message", "explanation"],
  });
  expect(
    tool.execute("1", {
      message: "fix: don't expand $()",
      explanation: "Review",
    }),
  ).toEqual({
    content: [{ type: "text", text: "Review" }],
    details: {
      command: commitCommand("fix: don't expand $()", "fish"),
      explanation: "Review",
    },
    terminate: true,
  });
  for (const args of [
    null,
    42,
    {},
    { message: "", explanation: "" },
    { message: "\u001b", explanation: "" },
  ])
    expect(() => tool.execute("1", args)).toThrow();
  expect(() =>
    commitProposalTool(
      () => false,
      () => "bash",
    ).execute("1", { message: "msg", explanation: "" }),
  ).toThrow();
});
