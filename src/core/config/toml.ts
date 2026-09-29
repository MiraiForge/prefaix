// Turning a parsed TOML document into a validated config object. Every key is
// optional, so each table starts from the schema defaults and only present
// keys are coerced; anything unexpected becomes a positioned diagnostic.

import { parse, TomlError } from "smol-toml";
import { isAbsolute } from "node:path";
import {
  camelize,
  expandHome,
  isHomeRelative,
  type FieldNode,
  type Members,
  type Node,
  isNode,
  memberDefaults,
} from "./schema.js";
import {
  fileDiagnostic,
  type ConfigDiagnostic,
  positionAt,
} from "./diagnostics.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return `a string (${JSON.stringify(value)})`;
  }
  if (typeof value === "boolean") {
    return `a boolean (${value})`;
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `an integer (${value})`
      : `a number (${value})`;
  }
  if (Array.isArray(value)) {
    return `an array (${value.length} item${value.length === 1 ? "" : "s"})`;
  }
  if (isPlainObject(value)) {
    return "a table";
  }
  return "a value";
}

function list(values: readonly string[] | undefined): string {
  return values === undefined ? "" : ` (${values.join(", ")})`;
}

function checkRegex(pattern: string): string | undefined {
  try {
    new RegExp(pattern);
    return undefined;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return `${JSON.stringify(pattern)} is not a valid regular expression: ${detail}`;
  }
}

function checkItems(
  node: FieldNode,
  values: readonly string[],
): string | undefined {
  for (const [index, value] of values.entries()) {
    if (node.values !== undefined && !node.values.includes(value)) {
      return `item ${index + 1} must be one of${list(node.values)}, got ${JSON.stringify(value)}`;
    }
    if (node.regex === true) {
      const problem = checkRegex(value);
      if (problem !== undefined) {
        return `item ${index + 1}: ${problem}`;
      }
    }
  }
  return undefined;
}

// Returns a problem description for a value that has the right TOML shape but
// the wrong contents. Shared by the file and env paths.
export function checkFieldValue(
  node: FieldNode,
  value: unknown,
): string | undefined {
  switch (node.kind) {
    case "string":
      return value === "" ? "must not be empty" : undefined;
    case "enum": {
      const allowed = node.values ?? [];
      return allowed.includes(String(value))
        ? undefined
        : `must be one of${list(allowed)}, got ${JSON.stringify(value)}`;
    }
    case "optionalString":
    case "optionalPath":
      return value === "" ? "must not be empty when set" : undefined;
    case "boolean":
    case "integer":
    case "number":
    case "stringList":
    case "optionalStringList":
      return undefined;
  }
}

function checkNumber(node: FieldNode, value: number): string | undefined {
  if (node.kind === "integer" && !Number.isInteger(value)) {
    return `expected an integer, got the number ${value}`;
  }
  if (node.min !== undefined && value < node.min) {
    return `must be ${node.min} or more, got ${value}`;
  }
  return undefined;
}

export function coerceField(
  node: FieldNode,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; problem: string } {
  const fail = (problem: string) => ({ ok: false as const, problem });
  const done = (coerced: unknown) => ({ ok: true as const, value: coerced });

  switch (node.kind) {
    case "string":
      return typeof value === "string"
        ? done(value)
        : fail(`expected a string, got ${describeValue(value)}`);
    case "enum":
      return typeof value === "string"
        ? done(value)
        : fail(`expected a string, got ${describeValue(value)}`);
    case "optionalString":
      return typeof value === "string"
        ? done(value === "" ? null : value)
        : fail(`expected a string, got ${describeValue(value)}`);
    case "optionalPath":
      return typeof value === "string"
        ? done(value === "" ? null : value)
        : fail(`expected a string, got ${describeValue(value)}`);
    case "boolean":
      return typeof value === "boolean"
        ? done(value)
        : fail(`expected true or false, got ${describeValue(value)}`);
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return fail(`expected a number, got ${describeValue(value)}`);
      }
      return done(value);
    case "stringList":
    case "optionalStringList":
      if (!Array.isArray(value)) {
        return fail(`expected an array, got ${describeValue(value)}`);
      }
      if (value.some((item) => typeof item !== "string")) {
        return fail(
          `expected an array of strings, got ${describeValue(value)}`,
        );
      }
      return done(value as string[]);
  }
}

// Full check of an already well-typed value: shape plus contents.
export function validateFieldValue(
  node: FieldNode,
  value: unknown,
): string | undefined {
  if (node.kind === "optionalPath" && typeof value === "string") {
    return isHomeRelative(value) || isAbsolute(value)
      ? undefined
      : `must be an absolute path or start with "~", got ${JSON.stringify(value)}`;
  }
  const problem = checkFieldValue(node, value);
  if (problem !== undefined) {
    return problem;
  }
  if (node.regex === true && typeof value === "string") {
    return checkRegex(value);
  }
  if (Array.isArray(value)) {
    return checkItems(node, value as string[]);
  }
  if (typeof value === "number") {
    return checkNumber(node, value);
  }
  return undefined;
}

export interface ReadContext {
  readonly source: string;
  readonly home: string;
  readonly diagnostics: ConfigDiagnostic[];
  readonly paths: string[];
}

function report(context: ReadContext, path: string, message: string): void {
  const [line, column] = positionAt(context.source, path);
  context.diagnostics.push(fileDiagnostic(path, message, line, column));
}

function readNode(
  node: Node,
  value: unknown,
  path: string,
  context: ReadContext,
): unknown {
  if (isNode(node)) {
    const coerced = coerceField(node, value);
    if (!coerced.ok) {
      report(context, path, coerced.problem);
      return node.default;
    }
    const expanded =
      node.kind === "optionalPath" && typeof coerced.value === "string"
        ? expandHome(coerced.value, context.home)
        : coerced.value;
    const problem = validateFieldValue(node, expanded);
    if (problem !== undefined) {
      report(context, path, problem);
      return node.default;
    }
    context.paths.push(path);
    return expanded;
  }
  if (node.type === "section") {
    return readMembers(node.members, value, path, context);
  }
  return readMap(node.entry, value, path, context);
}

function readMembers(
  members: Members,
  value: unknown,
  path: string,
  context: ReadContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = memberDefaults(members);
  if (value === undefined) {
    return out;
  }
  if (!isPlainObject(value)) {
    report(context, path, `expected a table, got ${describeValue(value)}`);
    return out;
  }
  for (const [key, member] of Object.entries(value)) {
    const known = members[key];
    if (known === undefined) {
      report(context, path === "" ? key : `${path}.${key}`, "unknown key");
      continue;
    }
    out[camelize(key)] = readNode(
      known,
      member,
      path === "" ? key : `${path}.${key}`,
      context,
    );
  }
  return out;
}

function readMap(
  entry: Members,
  value: unknown,
  path: string,
  context: ReadContext,
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    report(context, path, `expected a table, got ${describeValue(value)}`);
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(value)) {
    out[name] = readMembers(
      entry,
      member,
      path === "" ? name : `${path}.${name}`,
      context,
    );
  }
  return out;
}

export interface ParsedDocument {
  readonly value: unknown;
  readonly diagnostics: ConfigDiagnostic[];
}

export function parseToml(source: string): ParsedDocument {
  try {
    return {
      value: parse(source, { unsafeKeyBehaviour: "throw" }),
      diagnostics: [],
    };
  } catch (cause) {
    if (cause instanceof TomlError) {
      return {
        value: undefined,
        diagnostics: [
          fileDiagnostic("", cause.message, cause.line, cause.column),
        ],
      };
    }
    throw cause;
  }
}

export function readConfigDocument(
  source: string,
  schema: Members,
  home: string,
): {
  readonly value: Record<string, unknown>;
  readonly diagnostics: ConfigDiagnostic[];
  readonly paths: string[];
} {
  const parsed = parseToml(source);
  const context: ReadContext = {
    source,
    home,
    diagnostics: [...parsed.diagnostics],
    paths: [],
  };
  const value = readMembers(schema, parsed.value, "", context);
  return {
    value,
    diagnostics: context.diagnostics,
    paths: context.paths,
  };
}
