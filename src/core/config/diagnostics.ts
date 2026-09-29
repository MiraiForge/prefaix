// Config diagnostics with file positions. TOML syntax errors carry their own
// line and column; schema errors are located by looking the key path back up in
// the source, so `prefaix config check` can point at the offending line.

export interface DiagnosticBase {
  readonly path: string;
  readonly message: string;
  readonly line: number | null;
  readonly column: number | null;
}

export interface FileDiagnostic extends DiagnosticBase {
  readonly origin: "file";
}

export interface EnvDiagnostic extends DiagnosticBase {
  readonly origin: "env";
  readonly env: string;
}

export type ConfigDiagnostic = FileDiagnostic | EnvDiagnostic;

export function fileDiagnostic(
  path: string,
  message: string,
  line: number | null,
  column: number | null,
): FileDiagnostic {
  return { origin: "file", path, message, line, column };
}

export function envDiagnostic(
  path: string,
  env: string,
  message: string,
): EnvDiagnostic {
  return { origin: "env", path, env, message, line: null, column: null };
}

export interface Position {
  readonly line: number;
  readonly column: number;
}

interface Header {
  readonly name: string;
  readonly position: Position;
}

const HEADER = /^\s*\[\[?\s*(.+?)\s*\]\]?\s*(#.*)?$/;

function unquote(segment: string): string {
  const match = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/.exec(segment);
  if (match === null) {
    return segment;
  }
  const value = match[1];
  return value === undefined
    ? (match[2] ?? "")
    : value.replaceAll(/\\(.)/g, "$1");
}

function headerName(body: string): string {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of body) {
    if (quote !== undefined) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ".") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => unquote(part.trim())).join(".");
}

function parseHeaders(lines: readonly string[]): Header[] {
  const headers: Header[] = [];
  lines.forEach((line, index) => {
    const match = HEADER.exec(line);
    if (match !== null && match[1] !== undefined) {
      headers.push({
        name: headerName(match[1]),
        position: { line: index + 1, column: 1 },
      });
    }
  });
  return headers;
}

const ASSIGNMENT = /^(\s*)((?:"[^"]*"|'[^']*'|[^=.\s])[^=]*?)\s*=/;

function lastHeader(
  headers: readonly Header[],
  matches: (header: Header) => boolean,
): Header | undefined {
  for (let index = headers.length - 1; index >= 0; index--) {
    const header = headers[index];
    if (header !== undefined && matches(header)) {
      return header;
    }
  }
  return undefined;
}

function assignmentKey(body: string): string | undefined {
  const match = ASSIGNMENT.exec(body);
  if (match === null || match[2] === undefined) {
    return undefined;
  }
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of match[2]) {
    if (quote !== undefined) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ".") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((part) => unquote(part.trim())).join(".");
}

// Prefers the key under its own table header, then the same key elsewhere, then
// the header of the containing table. Returns null for a path the source does
// not mention at all, such as a typo in the table name itself.
export function locatePath(source: string, path: string): Position | undefined {
  const lines = source.split("\n");
  const headers = parseHeaders(lines);
  const segments = path.split(".");
  const leaf = segments[segments.length - 1];
  if (leaf === undefined || leaf === "") {
    return undefined;
  }
  const parent = segments.slice(0, -1).join(".");
  // The table's own header wins over a nested one, so `[agent]` is preferred
  // over `[agent.pi]` when locating anything under agent.
  const header =
    lastHeader(headers, (candidate) => candidate.name === parent) ??
    lastHeader(headers, (candidate) =>
      parent === "" ? false : candidate.name.startsWith(`${parent}.`),
    );

  const start = header === undefined ? 0 : header.position.line;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (HEADER.test(line)) {
      continue;
    }
    if (assignmentKey(line) === path || assignmentKey(line) === leaf) {
      return { line: index + 1, column: line.search(/\S/) + 1 || 1 };
    }
  }

  return header?.position;
}

export function positionAt(
  source: string,
  path: string,
): readonly [number | null, number | null] {
  const position = locatePath(source, path);
  return position === undefined
    ? [null, null]
    : [position.line, position.column];
}

function label(diagnostic: ConfigDiagnostic, file: string | undefined): string {
  return diagnostic.origin === "env" ? diagnostic.env : (file ?? "config.toml");
}

// `file:line:column: key: message`, the shape editors and terminals can click.
export function formatDiagnostic(
  diagnostic: ConfigDiagnostic,
  file?: string,
): string {
  const where =
    diagnostic.line === null
      ? label(diagnostic, file)
      : `${label(diagnostic, file)}:${diagnostic.line}:${diagnostic.column ?? 1}`;
  return `${where}: ${diagnostic.path === "" ? "" : `${diagnostic.path}: `}${diagnostic.message}`;
}

export interface RenderOptions {
  readonly file?: string;
  readonly text?: string;
}

export function renderDiagnostics(
  diagnostics: readonly ConfigDiagnostic[],
  options: RenderOptions = {},
): string {
  const name = options.file ?? "config.toml";
  const lines = diagnostics.map((diagnostic) => {
    const head = formatDiagnostic(diagnostic, name);
    // A document-level problem comes from the parser, whose message already
    // carries the offending line and a caret.
    if (
      diagnostic.origin !== "file" ||
      diagnostic.path === "" ||
      diagnostic.line === null ||
      options.text === undefined
    ) {
      return head;
    }
    const source = options.text.split("\n")[diagnostic.line - 1];
    if (source === undefined) {
      return head;
    }
    const caret = " ".repeat(Math.max(0, (diagnostic.column ?? 1) - 1)) + "^";
    return `${head}\n${source}\n${caret}`;
  });
  return lines.join("\n\n");
}
