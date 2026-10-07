// The gate every model-touching operation passes through (DESIGN §12.4).
// A spike, a fixture recording, or a live smoke calls assertLiveAllowed()
// before it sends anything; the CLI form is for shell-driven checks.
//
// Development never bills Anthropic or OpenAI. Refusing here, rather than
// relying on a human reading the script, is the point: a spike is a throwaway
// file, and throwaway files are where a stray default provider does damage.

export const LIVE_ENV = {
  provider: "PREFAIX_LIVE_PROVIDER",
  model: "PREFAIX_LIVE_MODEL",
} as const;

export type Env = Readonly<Record<string, string | undefined>>;

export interface LiveRequest {
  readonly provider: string;
  readonly model: string;
  /** Spawn argv, already carrying --provider and --model. */
  readonly args: readonly string[];
}

export class LiveGuardError extends Error {
  override readonly name = "LiveGuardError";
}

const REFUSED_PROVIDERS: readonly string[] = [
  "anthropic",
  "openai",
  "openai-codex",
];
// An OpenRouter slug can name a refused vendor behind an allowed router.
const REFUSED_MODEL_PREFIXES = [
  "anthropic/",
  "openai/",
  "openai-codex/",
] as const;

function refuse(reason: string): never {
  throw new LiveGuardError(
    `${reason}. Refusing to send a model request. Use a fake backend, a fixture ` +
      `replay, or a no-model probe instead.`,
  );
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

export function assertLiveAllowed(env: Env = process.env): LiveRequest {
  const provider = env[LIVE_ENV.provider];
  const model = env[LIVE_ENV.model];

  if (isBlank(provider) || isBlank(model)) {
    refuse(
      `Both ${LIVE_ENV.provider} and ${LIVE_ENV.model} must be set (got ` +
        `${LIVE_ENV.provider}=${provider ?? ""} ${LIVE_ENV.model}=${model ?? ""})`,
    );
  }
  const named = (provider ?? "").trim();
  const slug = (model ?? "").trim();

  const lowered = named.toLowerCase();
  if (REFUSED_PROVIDERS.some((prefix) => lowered.startsWith(prefix))) {
    refuse(`${LIVE_ENV.provider} ${JSON.stringify(named)} is not allowed`);
  }
  const loweredModel = slug.toLowerCase();
  // Checked per segment, so a router-qualified slug cannot smuggle a refused
  // vendor past the check: openrouter/anthropic/claude starts with "openrouter".
  const segments = loweredModel.split("/");
  const vendor = REFUSED_MODEL_PREFIXES.map((prefix) =>
    prefix.replace("/", ""),
  );
  if (
    segments.some((segment) =>
      vendor.some((prefix) => segment.startsWith(prefix)),
    )
  ) {
    refuse(`model ${JSON.stringify(slug)} is not allowed`);
  }
  // A model slug with no vendor is ambiguous; pi would fall back to whatever
  // its configured default is, which is exactly what must never happen.
  if (!loweredModel.includes("/")) {
    refuse(
      `model ${JSON.stringify(slug)} has no provider prefix, so the default ` +
        `would be used instead`,
    );
  }

  return {
    provider: named,
    model: slug,
    // Never rely on pi's configured default: it is openai-codex here.
    args: ["--provider", named, "--model", slug],
  };
}
