// Error codes shared by the daemon wire protocol and the CLI (DESIGN §4.2,
// §4.3.2, §8). The wire carries ErrorInfo; `prefaix run` maps the code to its
// exit status.

export const ERROR_CODES = [
  "USAGE",
  "UNKNOWN_COMMAND",
  "UNSUPPORTED",
  "CONFIG_INVALID",
  "DAEMON_UNAVAILABLE",
  "PROTOCOL_MISMATCH",
  "AGENT_UNAVAILABLE",
  "AGENT_ERROR",
  "CONVERSATION_BUSY",
  "CONVERSATION_NOT_FOUND",
  "ABORTED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const EXIT = {
  ok: 0,
  agentError: 1,
  usage: 2,
  daemonUnavailable: 3,
  agentUnavailable: 4,
  aborted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const EXIT_BY_CODE: Record<ErrorCode, ExitCode> = {
  USAGE: EXIT.usage,
  UNKNOWN_COMMAND: EXIT.usage,
  UNSUPPORTED: EXIT.usage,
  CONFIG_INVALID: EXIT.usage,
  DAEMON_UNAVAILABLE: EXIT.daemonUnavailable,
  PROTOCOL_MISMATCH: EXIT.daemonUnavailable,
  AGENT_UNAVAILABLE: EXIT.agentUnavailable,
  AGENT_ERROR: EXIT.agentError,
  CONVERSATION_BUSY: EXIT.agentError,
  CONVERSATION_NOT_FOUND: EXIT.agentError,
  ABORTED: EXIT.aborted,
  INTERNAL: EXIT.agentError,
};

export function exitCodeFor(code: ErrorCode): ExitCode {
  return EXIT_BY_CODE[code];
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return (ERROR_CODES as readonly unknown[]).includes(value);
}

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  hint?: string;
}

export interface PrefaixErrorOptions {
  hint?: string;
  cause?: unknown;
}

export class PrefaixError extends Error {
  override readonly name = "PrefaixError";
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: PrefaixErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.code = code;
    this.hint = options.hint;
  }

  get exitCode(): ExitCode {
    return exitCodeFor(this.code);
  }

  toInfo(): ErrorInfo {
    return this.hint === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, hint: this.hint };
  }

  // Rebuilds an error received over the wire. A code this build doesn't know
  // (a newer daemon) degrades to INTERNAL instead of being trusted.
  static fromInfo(info: {
    code: string;
    message: string;
    hint?: string;
  }): PrefaixError {
    const code = isErrorCode(info.code) ? info.code : "INTERNAL";
    return new PrefaixError(
      code,
      info.message,
      info.hint === undefined ? {} : { hint: info.hint },
    );
  }
}

export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof PrefaixError) {
    return error.toInfo();
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL", message };
}

// Missing backend capabilities are a user-facing message, never a crash
// (DESIGN §4.4).
export function unsupported(backend: string, feature: string): PrefaixError {
  return new PrefaixError(
    "UNSUPPORTED",
    `${feature} isn't supported by ${backend}`,
  );
}
