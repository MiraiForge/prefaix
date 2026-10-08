// The configuration schema and its defaults, from DESIGN §6. One declarative
// table drives the resolved config, type and range validation, and the
// PREFAIX_* env override names, so those three cannot drift apart.

export const BACKENDS = ["pi", "fake"] as const;
export const EXTENSION_MODES = ["user", "none"] as const;
export const CWD_POLICIES = ["follow", "split", "stay"] as const;
export const RESUME_POLICIES = ["none", "last-in-root"] as const;
export const THINKING_DISPLAYS = ["hidden", "summary", "stream"] as const;
export const FOOTER_FIELDS = ["time", "tools", "cost", "context", "model"];
export const RPROMPT_MODES = ["auto", "on", "off"] as const;
export const WIDGET_MODES = ["ignore", "info"] as const;
// DESIGN §6 only documents "auto" for osc133. It keeps the auto/on/off shape of
// the sibling rprompt mode so the field is not a one-value trap.
export const OSC_MODES = ["auto", "on", "off"] as const;
export const PICKER_MODES = ["auto", "builtin"] as const;
export const ENV_PASSTHROUGH_MODES = ["all", "allowlist"] as const;

export type BackendId = (typeof BACKENDS)[number];
export type ExtensionMode = (typeof EXTENSION_MODES)[number];
export type CwdPolicy = (typeof CWD_POLICIES)[number];
export type ResumePolicy = (typeof RESUME_POLICIES)[number];
export type ThinkingDisplay = (typeof THINKING_DISPLAYS)[number];
export type RpromptMode = (typeof RPROMPT_MODES)[number];
export type WidgetMode = (typeof WIDGET_MODES)[number];
export type OscMode = (typeof OSC_MODES)[number];
export type PickerMode = (typeof PICKER_MODES)[number];
export type EnvPassthroughMode = (typeof ENV_PASSTHROUGH_MODES)[number];

export type ConfigValue = string | number | boolean | string[] | null;

export type FieldKind =
  | "string"
  | "enum"
  | "optionalString"
  | "optionalPath"
  | "boolean"
  | "integer"
  | "number"
  | "stringList"
  | "optionalStringList";

export interface FieldNode {
  readonly type: "field";
  readonly key: string;
  readonly kind: FieldKind;
  readonly default: ConfigValue;
  readonly values?: readonly string[];
  readonly min?: number;
  // Each string must compile as a RegExp.
  readonly regex?: boolean;
  // Env names in addition to the one derived from the key path.
  readonly aliases?: readonly string[];
}

export type Members = Readonly<Record<string, Node>>;

export interface SectionNode {
  readonly type: "section";
  readonly members: Members;
}

// A user-extensible table: `personas.<name>`. Its entry members are fields, and
// `defaults` holds the entries prefaix ships with (DESIGN §6). A user entry
// with the same name replaces the default rather than merging into it, so
// `[personas.ask] tools = [...]` is a complete override and never a surprise
// half-override.
export interface MapNode {
  readonly type: "map";
  readonly entry: Members;
  readonly defaults?: Readonly<Record<string, unknown>>;
}

export type Node = FieldNode | SectionNode | MapNode;

export interface PrefaixConfig {
  agent: {
    backend: BackendId;
    pi: {
      bin: string;
      model: string | null;
      thinking: string | null;
      extensions: ExtensionMode;
      sessionDir: string | null;
      extraArgs: string[];
    };
  };
  pool: {
    maxChildren: number;
    idleMinutes: number;
    spare: boolean;
  };
  workspace: {
    cwdPolicy: CwdPolicy;
    resume: ResumePolicy;
  };
  ui: {
    thinking: ThinkingDisplay;
    footer: string[];
    rprompt: RpromptMode;
    widgets: WidgetMode;
    setTitle: boolean;
    osc133: OscMode;
    picker: PickerMode;
  };
  context: {
    recentCommands: number;
    includeExitCodes: boolean;
    redact: boolean;
    extraRedactPatterns: string[];
  };
  env: {
    passthrough: EnvPassthroughMode;
    allowlist: string[] | null;
    deny: string[];
  };
  grammar: {
    passthrough: string;
  };
  personas: Record<string, PersonaEntry>;
  commands: {
    suggest: { model: string | null };
    commit: { maxDiffBytes: number };
  };
}

export interface PersonaEntry {
  tools: string[] | null;
  guideline: string | null;
}

interface FieldOptions {
  values?: readonly string[];
  min?: number;
  regex?: boolean;
  aliases?: readonly string[];
}

function field(
  key: string,
  kind: FieldKind,
  defaultValue: ConfigValue,
  options: FieldOptions = {},
): FieldNode {
  return {
    type: "field",
    key,
    kind,
    default: defaultValue,
    ...(options.values === undefined ? {} : { values: options.values }),
    ...(options.min === undefined ? {} : { min: options.min }),
    ...(options.regex === true ? { regex: true } : {}),
    ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
  };
}

function section(members: Members): SectionNode {
  return { type: "section", members };
}

function map(
  entry: Members,
  defaults: Readonly<Record<string, unknown>>,
): MapNode {
  return { type: "map", entry, defaults };
}

export const CONFIG_SCHEMA: SectionNode = section({
  agent: section({
    backend: field("backend", "enum", "pi", {
      values: BACKENDS,
      aliases: ["PREFAIX_BACKEND"],
    }),
    pi: section({
      bin: field("bin", "string", "pi"),
      model: field("model", "optionalString", null),
      thinking: field("thinking", "optionalString", null),
      extensions: field("extensions", "enum", "user", {
        values: EXTENSION_MODES,
      }),
      session_dir: field("session_dir", "optionalPath", null),
      extra_args: field("extra_args", "stringList", []),
    }),
  }),
  pool: section({
    max_children: field("max_children", "integer", 6, { min: 1 }),
    idle_minutes: field("idle_minutes", "number", 15, { min: 0 }),
    spare: field("spare", "boolean", true),
  }),
  workspace: section({
    cwd_policy: field("cwd_policy", "enum", "split", { values: CWD_POLICIES }),
    resume: field("resume", "enum", "none", { values: RESUME_POLICIES }),
  }),
  ui: section({
    thinking: field("thinking", "enum", "hidden", {
      values: THINKING_DISPLAYS,
    }),
    footer: field("footer", "stringList", [...FOOTER_FIELDS], {
      values: FOOTER_FIELDS,
    }),
    rprompt: field("rprompt", "enum", "auto", { values: RPROMPT_MODES }),
    widgets: field("widgets", "enum", "ignore", { values: WIDGET_MODES }),
    set_title: field("set_title", "boolean", false),
    osc133: field("osc133", "enum", "auto", { values: OSC_MODES }),
    picker: field("picker", "enum", "auto", { values: PICKER_MODES }),
  }),
  context: section({
    recent_commands: field("recent_commands", "integer", 10, { min: 0 }),
    include_exit_codes: field("include_exit_codes", "boolean", true),
    redact: field("redact", "boolean", true),
    extra_redact_patterns: field("extra_redact_patterns", "stringList", [], {
      regex: true,
    }),
  }),
  env: section({
    passthrough: field("passthrough", "enum", "all", {
      values: ENV_PASSTHROUGH_MODES,
    }),
    allowlist: field("allowlist", "optionalStringList", null),
    deny: field("deny", "stringList", [
      "PREFAIX_*",
      "PWD",
      "OLDPWD",
      "SHLVL",
      "_",
    ]),
  }),
  grammar: section({
    passthrough: field("passthrough", "string", "^:\\s*($|[>|<&;$({\\[])", {
      regex: true,
    }),
  }),
  personas: map(
    {
      tools: field("tools", "optionalStringList", null),
      guideline: field("guideline", "optionalString", null),
    },
    {
      ask: {
        tools: ["read", "grep", "find", "ls"],
        guideline: "Answer the question. Do not modify files.",
      },
      plan: {
        tools: ["read", "grep", "find", "ls"],
        guideline: "Produce a numbered plan. Do not modify files.",
      },
    },
  ),
  commands: section({
    suggest: section({
      model: field("model", "optionalString", null),
    }),
    commit: section({
      max_diff_bytes: field("max_diff_bytes", "integer", 100_000, { min: 0 }),
    }),
  }),
});

// TOML keys are snake_case; the resolved config uses camelCase.
export function camelize(key: string): string {
  return key.replaceAll(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

// `agent.pi.session_dir` -> `PREFAIX_AGENT_PI_SESSION_DIR` (DESIGN §6).
export function envNameFor(path: string): string {
  return `PREFAIX_${path.replaceAll(".", "_").toUpperCase()}`;
}

// A leading `~` is expanded when the file is read, so path-kind fields always
// hold absolute paths.
export function expandHome(value: string, home: string): string {
  return value === "~" || value.startsWith("~/")
    ? `${home}${value.slice(1)}`
    : value;
}

export function isHomeRelative(value: string): boolean {
  return value === "~" || value.startsWith("~/");
}

export function isNode(value: Node): value is FieldNode {
  return value.type === "field";
}

export function joinPath(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

function cloneValue(value: ConfigValue): ConfigValue {
  return Array.isArray(value) ? [...value] : value;
}

// A map's default entry is a small record of ConfigValues, so it is copied one
// field at a time rather than spread, which would share the array a field holds.
function cloneTableEntry(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return entry;
  }
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(entry)) {
    out[field] =
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
        ? value
        : Array.isArray(value)
          ? [...value]
          : value;
  }
  return out;
}

export function mapDefaults(node: MapNode): Record<string, unknown> {
  const table: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(node.defaults ?? {}))
    table[name] = cloneTableEntry(entry);
  return table;
}

export function memberDefaults(members: Members): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const [key, node] of Object.entries(members)) {
    if (isNode(node)) {
      out[camelize(key)] = cloneValue(node.default);
    } else if (node.type === "section") {
      out[camelize(key)] = memberDefaults(
        node.members,
      ) as unknown as ConfigValue;
    } else {
      out[camelize(key)] = mapDefaults(node) as unknown as ConfigValue;
    }
  }
  return out;
}

// The resolved config is shared by the daemon, client, and pool, so it is
// frozen: a component that needs a variant must spread.
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function defaultConfig(): PrefaixConfig {
  return deepFreeze(
    memberDefaults(CONFIG_SCHEMA.members) as unknown as PrefaixConfig,
  );
}
