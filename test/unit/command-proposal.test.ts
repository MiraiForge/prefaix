import { expect, it } from "vitest";
import {
  parseCommandProposal,
  suggestGuideline,
} from "../../src/core/command-proposal.js";

it.each([
  null,
  undefined,
  true,
  1,
  "echo x",
  [],
  {},
  { command: "", explanation: "" },
  { command: " \t\n", explanation: "" },
  { command: 1, explanation: "" },
  { command: "echo x" },
  { command: "echo x", explanation: null },
  { command: "echo\0x", explanation: "" },
  { command: "\x1b[2Jecho x", explanation: "" },
  { command: "echo\rx", explanation: "" },
  { command: "echo\x7fx", explanation: "" },
  { command: "echo\x9bx", explanation: "" },
])("rejects malformed or non-editable proposal %#", (value) => {
  expect(parseCommandProposal(value)).toBeUndefined();
});

it("preserves literal syntax, Unicode, whitespace, and multiline shell data", () => {
  const command =
    "  printf '%s' \"$(touch sentinel)\" | grep 日本語🙂\n\techo done  ";
  expect(
    parseCommandProposal({
      command,
      explanation: "Review first.",
      extra: true,
    }),
  ).toEqual({ command, explanation: "Review first." });
});

it("accepts an empty explanation and does not scrape fences or JSON prose", () => {
  expect(parseCommandProposal({ command: "echo x", explanation: "" })).toEqual({
    command: "echo x",
    explanation: "",
  });
  expect(
    parseCommandProposal('{"command":"echo x","explanation":""}'),
  ).toBeUndefined();
});

it("does not trust inherited fields or invoke property getters", () => {
  const prototype = { command: "echo x", explanation: "" };
  expect(parseCommandProposal(Object.create(prototype))).toBeUndefined();
  const value = { explanation: "" };
  Object.defineProperty(value, "command", {
    get: () => {
      throw new Error("must not read accessor");
    },
  });
  expect(parseCommandProposal(value)).toBeUndefined();
});

it.each(["zsh", "fish", "bash"] as const)(
  "gives %s-specific edit guidance",
  (shell) => {
    const text = suggestGuideline(shell);
    expect(text).toContain(`user's ${shell} shell`);
    expect(text).toContain("Call propose_command");
    expect(text).toContain("Do not run the command");
    expect(text).toContain("Only the user pressing Enter may execute it");
  },
);
