// Redaction of the recent-commands list before it leaves the client
// (DESIGN §7.3). The point is not to hide a secret from a determined reader of
// the transcript; it is that a command line is the one place a user routinely
// types a token in the clear, and it does not belong in a model's context.
//
// The rules are deliberately shape-based, so they work on commands nobody
// wrote a test for, and each one has a false-positive case in the corpus.

import { compilePattern } from "../core/pattern.js";

export const REDACTED = "‹redacted›";

// Known token shapes. The boundaries matter: `sk-` alone is a prefix of many
// ordinary words, so a minimum body length keeps `sk-learn` intact.
const TOKEN_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{12,}\b/g, // AWS access key id
  /\bAIza[A-Za-z0-9_-]{20,}/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

// NAME=value where the name looks like a credential. The value stops at the
// first quote or space so a whole rest-of-command is not swallowed.
//
// `_FILE`, `_PATH`, `_DIR` and `_CMD` are excluded: `POSTGRES_PASSWORD_FILE`
// names where the secret lives, it is not the secret, and redacting the path
// would hide the one useful fact in the command.
const NAMED_ASSIGNMENT =
  /(\b(?![A-Za-z0-9_]*(?:_FILE|_PATH|_DIR|_CMD)\b)[A-Za-z0-9_]*(?:key|token|secret|pass(?:word)?|auth|cookie)[A-Za-z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi;

// Flags that carry a value, for the tools that take credentials as arguments.
const SECRET_FLAGS =
  /(--password|--passwd|--token|--secret|--api[-_]?key|--auth)(\s+|=)("[^"]*"|'[^']*'|\S+)/gi;

// Credentials embedded in a connection URL: scheme://user:pass@host.
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi;

function collapse(match: string): string {
  // A multi-line private key collapses to one marker, because a prompt section
  // is not the place for a wall of base64.
  return match.includes("\n") ? "‹redacted key›" : REDACTED;
}

export interface RedactOptions {
  readonly patterns?: readonly string[];
  readonly enabled?: boolean;
}

export class Redactor {
  readonly #custom: readonly RegExp[];
  readonly #enabled: boolean;

  constructor(options: RedactOptions = {}) {
    this.#enabled = options.enabled ?? true;
    // The config loader already validated these, but a caller that builds a
    // Redactor by hand can pass anything. A pattern that will not compile is
    // dropped rather than crashing every turn from now on.
    this.#custom = (options.patterns ?? [])
      .map((source) => compilePattern(source, "g"))
      .filter((pattern): pattern is RegExp => pattern !== undefined);
  }

  redact(text: string): string {
    if (!this.#enabled || text === "") {
      return text;
    }
    let out = text;
    for (const shape of TOKEN_SHAPES) {
      out = out.replace(shape, collapse);
    }
    out = out.replace(URL_CREDENTIALS, `$1${REDACTED}$2`);
    out = out.replace(
      NAMED_ASSIGNMENT,
      (_match, prefix: string, value: string) => {
        const quote = /^["']/.exec(value)?.[0];
        return `${prefix}${quote ?? ""}${REDACTED}${quote ?? ""}`;
      },
    );
    out = out.replace(
      SECRET_FLAGS,
      (_match, flag: string, gap: string, value: string) => {
        const quote = /^["']/.exec(value)?.[0];
        return `${flag}${gap}${quote ?? ""}${REDACTED}${quote ?? ""}`;
      },
    );
    for (const pattern of this.#custom) {
      out = out.replace(pattern, REDACTED);
    }
    return out;
  }
}

export function redact(text: string, options: RedactOptions = {}): string {
  return new Redactor(options).redact(text);
}
