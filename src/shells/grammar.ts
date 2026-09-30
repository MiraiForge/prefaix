// The authoritative line grammar (DESIGN §3.1).
//
// The shell plugins do a cheap prefix test and hand the raw buffer here as a
// single argv element, so this file is the only thing that decides what a line
// means. That is the whole reason the three shells cannot drift: they are three
// ways of calling one function.
//
// Only the first line is inspected, because a `:` in the middle of a multi-line
// buffer is not what the user is asking prefaix for.

export const DEFAULT_PASSTHROUGH = "^:\\s*($|[>|<&;$({\\[])";

/** A prefaix command, before the milestone that introduces it. */
export interface CommandSpec {
  readonly name: string;
  readonly aliases: readonly string[];
  /** `run` prints output and shows a fresh prompt; `edit` fills the buffer. */
  readonly class: "run" | "edit";
  readonly milestone: "MVP" | "M4" | "M5";
  readonly summary: string;
  /**
   * Whether the command takes an argument. A command that takes none and is
   * given one is a prompt instead, because `: copy the file` and
   * `: abort everything` are sentences, not mistakes.
   */
  readonly takesArgs: boolean;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "new",
    takesArgs: true,
    aliases: ["n"],
    class: "run",
    milestone: "MVP",
    summary: "Start a new conversation, optionally prompting it at once.",
  },
  {
    name: "conversation",
    takesArgs: true,
    aliases: ["c"],
    class: "run",
    milestone: "MVP",
    summary: "Switch to another conversation; `:c -` returns to the last one.",
  },
  {
    name: "model",
    takesArgs: true,
    aliases: ["m"],
    class: "run",
    milestone: "MVP",
    summary: "Pick or set the model for this conversation.",
  },
  {
    name: "think",
    takesArgs: true,
    aliases: [],
    class: "run",
    milestone: "MVP",
    summary: "Set the thinking level: off, low, medium, high, max.",
  },
  {
    name: "info",
    takesArgs: false,
    aliases: ["i"],
    class: "run",
    milestone: "MVP",
    summary:
      "Show the conversation, model, cost, context, backend, and daemon.",
  },
  {
    name: "copy",
    takesArgs: false,
    aliases: [],
    class: "run",
    milestone: "MVP",
    summary: "Copy the last answer to the clipboard.",
  },
  {
    name: "help",
    takesArgs: true,
    aliases: ["?"],
    class: "run",
    milestone: "MVP",
    summary: "Show this grammar and the command list.",
  },
  {
    name: "doctor",
    takesArgs: false,
    aliases: [],
    class: "run",
    milestone: "MVP",
    summary: "Check pi, the shell, the socket, and the config.",
  },
  {
    name: "suggest",
    takesArgs: true,
    aliases: ["s"],
    class: "edit",
    milestone: "M4",
    summary: "Generate one shell command into the buffer without running it.",
  },
  {
    name: "commit",
    takesArgs: true,
    aliases: [],
    class: "edit",
    milestone: "M4",
    summary: "Put a `git commit` for the staged diff into the buffer.",
  },
  {
    name: "retry",
    takesArgs: false,
    aliases: ["r"],
    class: "run",
    milestone: "M4",
    summary: "Run the last prompt again.",
  },
  {
    name: "compact",
    takesArgs: true,
    aliases: [],
    class: "run",
    milestone: "M4",
    summary: "Compact the conversation, optionally around a focus.",
  },
  {
    name: "rename",
    takesArgs: true,
    aliases: ["rn"],
    class: "run",
    milestone: "M4",
    summary: "Rename the conversation.",
  },
  {
    name: "skill",
    takesArgs: true,
    aliases: [],
    class: "run",
    milestone: "M4",
    summary: "Run an agent skill by name.",
  },
  {
    name: "ask",
    takesArgs: true,
    aliases: [],
    class: "run",
    milestone: "M4",
    summary: "Answer with read-only tools; nothing is modified.",
  },
  {
    name: "plan",
    takesArgs: true,
    aliases: [],
    class: "run",
    milestone: "M4",
    summary: "Produce a numbered plan with read-only tools.",
  },
  {
    name: "attach",
    takesArgs: false,
    aliases: [],
    class: "run",
    milestone: "M4",
    summary: "Re-attach to a turn and replay its output.",
  },
  {
    name: "abort",
    takesArgs: false,
    aliases: [],
    class: "run",
    milestone: "M4",
    summary: "Stop a detached turn.",
  },
  {
    name: "tui",
    takesArgs: false,
    aliases: [],
    class: "run",
    milestone: "M4",
    summary: "Hand this conversation to pi's own TUI.",
  },
  {
    name: "backend",
    takesArgs: true,
    aliases: [],
    class: "run",
    milestone: "M5",
    summary: "Show the active agent backend.",
  },
];

export const COMMAND_NAMES: readonly string[] = COMMANDS.flatMap((command) => [
  command.name,
  ...command.aliases,
]);

/** Persona names the grammar accepts as a verb. M4 turns them into a turn. */
export const PERSONA_NAMES: readonly string[] = ["ask", "plan"];

export type Parsed =
  | { readonly kind: "pass"; readonly line: string; readonly reason: string }
  | {
      readonly kind: "prompt";
      readonly text: string;
      readonly newConversation: boolean;
      readonly persona?: string;
    }
  | {
      readonly kind: "command";
      readonly name: string;
      readonly args: string;
      readonly class: "run" | "edit";
      readonly milestone: "MVP" | "M4" | "M5";
      readonly summary: string;
      readonly known: boolean;
    }
  | {
      readonly kind: "agent";
      readonly name: string;
      readonly args: string;
    };

export interface GrammarOptions {
  /** The passthrough pattern, from `grammar.passthrough` in the config. */
  readonly passthrough?: string;
  /** Persona names from config, which extend the built-in two. */
  readonly personas?: readonly string[];
  /** Milestones whose commands this build actually implements. */
  readonly implemented?: "MVP" | "M4" | "M5";
}

const ESCAPED = /^\\:/u;
// What a name has to look like for the unknown-command error to apply. `?` is
// the `:help` alias, so it is a name character too.
const COMMAND_NAME_SHAPE = /^[A-Za-z?][A-Za-z0-9_-]*$/u;
// A word made only of shell metacharacters is shell syntax, not a name anyone
// could have misspelled.
const SHELL_PUNCTUATION = /^[:!%&|><(){}[\];]+$/u;

function commandFor(name: string): CommandSpec | undefined {
  return COMMANDS.find(
    (command) => command.name === name || command.aliases.includes(name),
  );
}

/**
 * What the buffer means. The order of the checks is the specification: a
 * leading space or a backslash is an escape hatch, the configured passthrough
 * is the shell's own idiom, and only then is this a prefaix line.
 */
export function parseLine(raw: string, options: GrammarOptions = {}): Parsed {
  const parsed = parseFirstLine(raw, options);
  const line = raw.replace(/[\r\n]+$/u, "");
  const newline = line.search(/\r?\n/u);
  if (newline === -1 || parsed.kind === "pass") return parsed;
  const tail = line.slice(newline);
  // The first line determines routing; continuation lines remain literal
  // content. Classification must never discard part of the user's prompt.
  return parsed.kind === "prompt"
    ? { ...parsed, text: parsed.text + tail }
    : { ...parsed, args: parsed.args + tail };
}

function parseFirstLine(raw: string, options: GrammarOptions): Parsed {
  const line = raw.replace(/[\r\n]+$/u, "");
  // Only the first line decides: a `:` in the middle of a multi-line buffer is
  // not what the user is asking prefaix for.
  const newline = line.search(/\r?\n/u);
  const firstLine = (newline === -1 ? line : line.slice(0, newline)).replace(
    /\r+$/u,
    "",
  );

  if (firstLine === "" || !firstLine.startsWith(":")) {
    // A leading space is the documented escape hatch, and it never reaches
    // here: the line does not start with a colon at all.
    return { kind: "pass", line, reason: "not a prefaix line" };
  }
  if (ESCAPED.test(firstLine)) {
    return { kind: "pass", line, reason: "escaped with a backslash" };
  }

  const passthrough = passthroughOf(options);
  if (passthrough !== undefined && passthrough.test(firstLine)) {
    // `: >file`, `: ${X:=1}`, `:;` and a bare `:` all belong to the shell, and
    // the configured pattern is what says so (DESIGN §3.1).
    return { kind: "pass", line, reason: "matches grammar.passthrough" };
  }

  const rest = firstLine.slice(1).trimStart();
  const tightName = !/^:\s/u.test(firstLine);
  if (rest === "") {
    return { kind: "prompt", text: "", newConversation: false };
  }

  if (rest.startsWith("/")) {
    const agent = /^([A-Za-z][A-Za-z0-9:_-]*)\s*/u.exec(rest.slice(1));
    if (agent === null) {
      return { kind: "pass", line, reason: "not an agent command name" };
    }
    // The group matched, so the name is there and the whole match is how much
    // of the line it took.
    return {
      kind: "agent",
      name: agent[1] as string,
      args: rest.slice(1 + agent[0].length),
    };
  }

  // The name is the first word, whatever it is made of. Anything that is not a
  // known command in a spaced sentence is a prompt, which is what makes
  // `: 3 + 4` and `: 日本語で答えて` work.
  const head = /^(\S+)\s*/u.exec(rest);
  // `rest` is not empty, so it starts with a non-space character and the head
  // always matches; the group is the name and the match is name plus spacing.
  const name = head?.[1] as string;
  const args = rest.slice((head?.[0] ?? "").length);

  const personas = [...PERSONA_NAMES, ...(options.personas ?? [])];
  if (personas.includes(name) && args !== "") {
    return {
      kind: "prompt",
      text: args,
      newConversation: false,
      persona: name,
    };
  }

  const command = commandFor(name);
  // `: copy the file` is a sentence. A command that takes no argument and was
  // given one is not that command; it is a prompt that happens to start with
  // the command's name.
  if (
    command !== undefined &&
    (tightName || args === "" || command.takesArgs)
  ) {
    return {
      kind: "command",
      name,
      args,
      class: command.class,
      milestone: command.milestone,
      summary: command.summary,
      known: isImplemented(command, options),
    };
  }

  // Tight ASCII names are commands even when misspelled or given arguments.
  // Otherwise a typo such as `:modle gemini` would unexpectedly prompt a model.
  // Retain the spaced bare-typo affordance used by earlier prefaix versions.
  if (
    COMMAND_NAME_SHAPE.test(name) &&
    (tightName || (args === "" && suggestions(name).length > 0))
  ) {
    return {
      kind: "command",
      name,
      args,
      class: "run",
      milestone: "MVP",
      summary: "unknown command",
      known: false,
    };
  }
  if (args === "" && SHELL_PUNCTUATION.test(name)) {
    // `::`, `:-` and `:;` are not a misspelled command; they are the shell's
    // own syntax, and passing them through is what the user meant.
    return { kind: "pass", line, reason: "not a command name" };
  }
  return { kind: "prompt", text: rest, newConversation: false };
}

function isImplemented(command: CommandSpec, options: GrammarOptions): boolean {
  const reached = options.implemented ?? "MVP";
  const order = { MVP: 0, M4: 1, M5: 2 } as const;
  return order[command.milestone] <= order[reached];
}

function passthroughOf(options: GrammarOptions): RegExp | undefined {
  const source = options.passthrough ?? DEFAULT_PASSTHROUGH;
  try {
    return new RegExp(source, "u");
  } catch {
    // A config that does not compile falls back to the documented default
    // rather than letting every `:` through.
    return new RegExp(DEFAULT_PASSTHROUGH, "u");
  }
}

/**
 * The closest known names to a misspelling, for the error an unknown bare
 * command produces. One edit is always a typo; a second is only offered for a
 * name long enough that two edits are still unambiguous, because `: nope` is
 * two edits from `: copy` and is almost certainly a prompt.
 */
export function suggestions(
  name: string,
  candidates: readonly string[] = COMMAND_NAMES,
): string[] {
  const needle = name.toLowerCase();
  if (needle === "") {
    return [];
  }
  const limit = needle.length >= 6 ? 2 : 1;
  return candidates
    .map((candidate) => ({
      candidate,
      distance: editDistance(needle, candidate.toLowerCase()),
    }))
    .filter(({ distance }) => distance <= limit)
    .sort(
      (a, b) =>
        a.distance - b.distance || a.candidate.localeCompare(b.candidate),
    )
    .slice(0, 3)
    .map((entry) => entry.candidate);
}

/**
 * Damerau-Levenshtein distance, so a swapped pair counts as one mistake.
 * `modle` for `model` is the most common typo there is, and plain Levenshtein
 * scores it as two, which would hide the one suggestion the user needs.
 */
function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  // A dense table of the right shape, filled row by row below.
  const distance: number[][] = Array.from({ length: rows }, () =>
    new Array<number>(cols).fill(0),
  );
  const row = (index: number): number[] => distance[index] as number[];
  // The table is dense and filled in order, so every cell the inner loop reads
  // already holds a number.
  const at = (i: number, j: number): number =>
    (distance[i] as number[])[j] as number;
  for (let i = 0; i < rows; i++) {
    row(i)[0] = i;
  }
  for (let j = 0; j < cols; j++) {
    row(0)[j] = j;
  }
  // Every cell the inner loop reads was filled by an earlier row or column, and
  // the table is dense, so the lookups are not optional in any meaningful way.
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = at(i - 1, j) + 1;
      const insertion = at(i, j - 1) + 1;
      const substitution = at(i - 1, j - 1) + cost;
      const best = Math.min(deletion, insertion, substitution);
      const swap =
        i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]
          ? at(i - 2, j - 2) + 1
          : Number.POSITIVE_INFINITY;
      row(i)[j] = Math.min(best, swap);
    }
  }
  return at(a.length, b.length);
}
