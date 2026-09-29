// One place that turns a configured pattern string into a RegExp.
//
// DESIGN §6 documents user patterns in the `(?i)internal-token-…` form, which
// is the Perl/Python spelling. JavaScript has no inline flag groups, so a
// leading `(?ims)` group is lifted into the flags argument here rather than
// each caller inventing its own half-support for it.

export const PATTERN_FLAGS = ["i", "m", "s", "u"] as const;

/** Flags JavaScript's RegExp understands, minus the ones it defaults on. */
const SUPPORTED = new Set<string>(["i", "m", "s"]);

export interface CompiledPattern {
  readonly source: string;
  readonly flags: string;
  /** The part of the string that could not be understood, if any. */
  readonly problem?: string;
}

/**
 * Splits a pattern into its leading inline flags and its body. A group that
 * appears anywhere but the front is left in the body, where the RegExp
 * constructor will reject it — which is the correct answer, because a
 * mid-pattern `(?i)` really is a mistake.
 */
export function splitInlineFlags(pattern: string): CompiledPattern {
  const match = /^\(\?([a-zA-Z]*)\)/.exec(pattern);
  if (match === null) {
    return { source: pattern, flags: "" };
  }
  // The group can be empty but is never absent, so a bare `(?:` is not a flag
  // group and does not match at all.
  const requested = match[1] as string;
  const body = pattern.slice(match[0].length);
  const unsupported = [...requested].filter((flag) => !SUPPORTED.has(flag));
  if (unsupported.length > 0) {
    return {
      source: body,
      flags: "",
      problem: `unsupported flag(s): ${unsupported.join("")}`,
    };
  }
  return { source: body, flags: requested };
}

export function compilePattern(
  pattern: string,
  flags = "g",
): RegExp | undefined {
  const split = splitInlineFlags(pattern);
  if (split.problem !== undefined) {
    return undefined;
  }
  // A user-supplied `g` would make a shared RegExp stateful across calls, so
  // the caller's global flag is always present and theirs are added to it.
  const all = new Set([...flags, ...split.flags]);
  try {
    return new RegExp(split.source, [...all].join(""));
  } catch {
    return undefined;
  }
}

export function isCompilablePattern(pattern: string): boolean {
  return compilePattern(pattern, "") !== undefined;
}
