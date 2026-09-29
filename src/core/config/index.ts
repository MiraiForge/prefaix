// Config loading: the TOML file, then PREFAIX_* overrides, then the frozen
// resolved config (DESIGN §6). `checkConfig` never throws, so `prefaix config
// check` can print every problem at once; `loadConfig` turns any diagnostic
// into a single CONFIG_INVALID error for callers that only need to fail.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { PrefaixError } from "../errors.js";
import { resolvePaths } from "../paths.js";
import type { PersonaSpec } from "../agent-port.js";
import {
  CONFIG_SCHEMA,
  camelize,
  deepFreeze,
  type ConfigValue,
  type PrefaixConfig,
} from "./schema.js";
import { applyEnvOverrides, type Env } from "./env.js";
import { readConfigDocument } from "./toml.js";
import { formatDiagnostic, type ConfigDiagnostic } from "./diagnostics.js";

export * from "./diagnostics.js";
export * from "./env.js";
export * from "./schema.js";
export { describeValue, parseToml } from "./toml.js";

export interface ResolveOptions {
  /** Config file contents. Defaults to an empty document. */
  readonly text?: string;
  readonly env?: Env;
  readonly home?: string;
}

export interface AppliedOverride {
  readonly env: string;
  readonly path: string;
}

export interface ResolvedConfig {
  readonly config: PrefaixConfig;
  readonly diagnostics: ConfigDiagnostic[];
  /** Key paths the file set, in TOML spelling. */
  readonly fromFile: readonly string[];
  /** Env overrides that were applied. */
  readonly fromEnv: readonly AppliedOverride[];
}

// env.passthrough = "allowlist" with no list would silently drop every
// variable, which reads as a broken daemon rather than a missing key.
function checkRelations(config: PrefaixConfig): ConfigDiagnostic[] {
  if (config.env.passthrough === "allowlist" && config.env.allowlist === null) {
    return [
      {
        origin: "file",
        path: "env.allowlist",
        message:
          'is required when env.passthrough is "allowlist" (write allowlist = [] to pass nothing)',
        line: null,
        column: null,
      },
    ];
  }
  return [];
}

export function resolveConfig(options: ResolveOptions = {}): ResolvedConfig {
  const home = options.home ?? homedir();
  const document = readConfigDocument(
    options.text ?? "",
    CONFIG_SCHEMA.members,
    home,
  );
  const overridden = applyEnvOverrides(
    document.value as unknown as PrefaixConfig,
    CONFIG_SCHEMA.members,
    options.env ?? {},
    home,
  );
  const config = deepFreeze(overridden.config);
  return {
    config,
    diagnostics: [
      ...document.diagnostics,
      ...overridden.diagnostics,
      ...checkRelations(config),
    ],
    fromFile: document.paths,
    fromEnv: overridden.applied,
  };
}

export function checkConfig(options: ResolveOptions = {}): ConfigDiagnostic[] {
  return resolveConfig(options).diagnostics;
}

export type ReadFile = (file: string) => string | undefined;

function readFileOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") {
      return undefined;
    }
    throw cause;
  }
}

export interface LoadOptions extends ResolveOptions {
  readonly file?: string;
  readonly readFile?: ReadFile;
}

export function loadConfig(options: LoadOptions = {}): PrefaixConfig {
  const file = options.file ?? resolvePaths().configFile;
  const text = options.text ?? (options.readFile ?? readFileOrUndefined)(file);
  const resolved = resolveConfig({
    ...(text === undefined ? {} : { text }),
    env: options.env ?? {},
    ...(options.home === undefined ? {} : { home: options.home }),
  });
  if (resolved.diagnostics.length > 0) {
    throw new PrefaixError(
      "CONFIG_INVALID",
      summarize(resolved.diagnostics, file),
      {
        hint: "Run `prefaix config check` for the full list.",
      },
    );
  }
  return resolved.config;
}

function summarize(
  diagnostics: readonly ConfigDiagnostic[],
  file: string,
): string {
  const [first, ...rest] = diagnostics;
  if (first === undefined) {
    return `${file}: invalid configuration`;
  }
  const more =
    rest.length === 0
      ? ""
      : ` (and ${rest.length} more problem${rest.length === 1 ? "" : "s"})`;
  return `${formatDiagnostic(first, file)}${more}`;
}

function readPath(config: unknown, path: string): ConfigValue | undefined {
  let current: unknown = config;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[camelize(segment)];
  }
  return current as ConfigValue | undefined;
}

function formatValue(value: ConfigValue | undefined): string {
  return value === undefined || value === null
    ? "unset"
    : JSON.stringify(value);
}

// The non-default settings prefaix would actually use, with the source of each.
// A setting an env var overrode is reported once, against the env var.
export function describeConfig(
  resolved: ResolvedConfig,
  options: { readonly file?: string } = {},
): string[] {
  const label = options.file ?? "config.toml";
  const overridden = new Set(resolved.fromEnv.map((entry) => entry.path));
  const lines = resolved.fromFile
    .filter((path) => !overridden.has(path))
    .map(
      (path) =>
        `  ${path} = ${formatValue(readPath(resolved.config, path))}  [${label}]`,
    );
  for (const override of resolved.fromEnv) {
    lines.push(
      `  ${override.path} = ${formatValue(
        readPath(resolved.config, override.path),
      )}  [${override.env}]`,
    );
  }
  return lines;
}

// The built-in personas map onto the AgentPort contract, so callers do not
// rebuild the conditional spread for `tools`/`guideline`.
export function personaSpec(
  config: PrefaixConfig,
  name: string,
): PersonaSpec | undefined {
  const entry = config.personas[name];
  if (entry === undefined) {
    return undefined;
  }
  return {
    name,
    ...(entry.tools === null ? {} : { tools: entry.tools }),
    ...(entry.guideline === null ? {} : { guideline: entry.guideline }),
  };
}
