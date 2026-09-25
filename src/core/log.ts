// A tiny leveled line logger. The daemon points it at its rotated log file;
// everything else defaults to stderr. Never pass env values as fields: logs
// may record env keys, and only in debug mode (DESIGN §10).

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  write?: (line: string) => void;
  now?: () => Date;
}

export function logLevelFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LogLevel {
  const debug = env["PREFAIX_DEBUG"];
  return debug && debug !== "0" ? "debug" : "info";
}

function escapeControl(text: string): string {
  return /\p{Cc}/u.test(text) ? JSON.stringify(text) : text;
}

function formatToken(text: string): string {
  return /^[^\s"=\p{Cc}]+$/u.test(text) ? text : JSON.stringify(text);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return formatToken(value);
  }
  if (value instanceof Error) {
    return JSON.stringify(`${value.name}: ${value.message}`);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

// One record per line: control characters in the scope, message, and field
// names and values are escaped, so no part of a call can forge extra records.
export function formatLogLine(
  time: Date,
  level: LogLevel,
  scope: string | undefined,
  message: string,
  fields: LogFields = {},
): string {
  const text = escapeControl(message);
  const parts = [time.toISOString(), level.toUpperCase().padEnd(5)];
  parts.push(scope === undefined ? text : `${escapeControl(scope)}: ${text}`);
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${formatToken(key)}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level ?? "info");
  const write =
    options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const make = (scope: string | undefined): Logger => {
    const at =
      (level: LogLevel) =>
      (message: string, fields?: LogFields): void => {
        if (LOG_LEVELS.indexOf(level) >= threshold) {
          write(formatLogLine(now(), level, scope, message, fields));
        }
      };
    return {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      child: (name) => make(scope === undefined ? name : `${scope}.${name}`),
    };
  };

  return make(options.scope);
}
