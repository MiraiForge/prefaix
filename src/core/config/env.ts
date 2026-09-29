// PREFAIX_* overrides. An env var name is the config key path in upper snake
// case (`agent.pi.bin` -> `PREFAIX_AGENT_PI_BIN`), so a value is always a
// string and is parsed back into the field's type. Env can change any leaf the
// config file defines or leaves at its default; it cannot introduce a key, such
// as a new `personas.<name>` table.

import {
  type FieldNode,
  type Members,
  type Node,
  type PrefaixConfig,
  camelize,
  envNameFor,
  expandHome,
  isNode,
  joinPath,
} from "./schema.js";
import { envDiagnostic, type ConfigDiagnostic } from "./diagnostics.js";
import { validateFieldValue } from "./toml.js";

const TRUE = ["1", "true", "yes", "on"];
const FALSE = ["0", "false", "no", "off"];
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export type Env = Readonly<Record<string, string | undefined>>;

function parseList(raw: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    return undefined;
  }
  return parsed as string[];
}

function parseEnvValue(
  node: FieldNode,
  raw: string,
  home: string,
): { ok: true; value: unknown } | { ok: false; problem: string } {
  const lower = raw.trim().toLowerCase();
  switch (node.kind) {
    case "boolean": {
      if (TRUE.includes(lower)) {
        return { ok: true, value: true };
      }
      if (FALSE.includes(lower)) {
        return { ok: true, value: false };
      }
      return {
        ok: false,
        problem: `expected a boolean (${[...TRUE, ...FALSE].join(", ")}), got ${JSON.stringify(raw)}`,
      };
    }
    case "integer":
    case "number": {
      if (!NUMBER.test(raw.trim())) {
        return {
          ok: false,
          problem: `expected a number, got ${JSON.stringify(raw)}`,
        };
      }
      return { ok: true, value: Number(raw.trim()) };
    }
    case "stringList":
    case "optionalStringList": {
      if (raw.trim() === "") {
        return { ok: true, value: node.kind === "stringList" ? [] : null };
      }
      const items = parseList(raw);
      return items === undefined
        ? {
            ok: false,
            problem: `expected a JSON array of strings, got ${JSON.stringify(raw)}`,
          }
        : { ok: true, value: items };
    }
    case "enum":
    case "string":
      return { ok: true, value: raw };
    case "optionalString":
    case "optionalPath": {
      if (raw === "") {
        return { ok: true, value: null };
      }
      return {
        ok: true,
        value: node.kind === "optionalPath" ? expandHome(raw, home) : raw,
      };
    }
  }
}

interface EnvContext {
  readonly env: Env;
  readonly home: string;
  readonly applied: AppliedOverride[];
  readonly diagnostics: ConfigDiagnostic[];
}

function envNamesFor(node: FieldNode, path: string): string[] {
  return [envNameFor(path), ...(node.aliases ?? [])];
}

function applyField(
  node: FieldNode,
  value: unknown,
  path: string,
  context: EnvContext,
): unknown {
  for (const name of envNamesFor(node, path)) {
    const raw = context.env[name];
    if (raw === undefined) {
      continue;
    }
    const parsed = parseEnvValue(node, raw, context.home);
    if (!parsed.ok) {
      context.diagnostics.push(envDiagnostic(path, name, parsed.problem));
      continue;
    }
    const problem = validateFieldValue(node, parsed.value);
    if (problem !== undefined) {
      context.diagnostics.push(envDiagnostic(path, name, problem));
      continue;
    }
    context.applied.push({ env: name, path });
    return parsed.value;
  }
  return value;
}

function applyNode(
  node: Node,
  value: unknown,
  path: string,
  context: EnvContext,
): unknown {
  if (isNode(node)) {
    return applyField(node, value, path, context);
  }
  if (node.type === "section") {
    return applyMembers(node.members, value, path, context);
  }
  return applyMap(node.entry, value, path, context);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function applyMembers(
  members: Members,
  value: unknown,
  path: string,
  context: EnvContext,
): Record<string, unknown> {
  const source = asRecord(value);
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(members)) {
    const child = joinPath(path, key);
    out[camelize(key)] = applyNode(
      member,
      source[camelize(key)],
      child,
      context,
    );
  }
  return out;
}

function applyMap(
  entry: Members,
  value: unknown,
  path: string,
  context: EnvContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(asRecord(value))) {
    out[name] = applyMembers(entry, member, joinPath(path, name), context);
  }
  return out;
}

export interface AppliedOverride {
  readonly env: string;
  readonly path: string;
}

export interface EnvResult {
  readonly config: PrefaixConfig;
  readonly applied: readonly AppliedOverride[];
  readonly diagnostics: ConfigDiagnostic[];
}

export function applyEnvOverrides(
  config: PrefaixConfig,
  schema: Members,
  env: Env,
  home: string,
): EnvResult {
  const context: EnvContext = {
    env,
    home,
    applied: [],
    diagnostics: [],
  };
  const value = applyMembers(
    schema,
    config,
    "",
    context,
  ) as unknown as PrefaixConfig;
  return {
    config: value,
    applied: context.applied,
    diagnostics: context.diagnostics,
  };
}
