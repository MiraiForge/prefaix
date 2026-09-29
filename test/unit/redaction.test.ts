import { describe, expect, it } from "vitest";
import { Redactor, redact } from "../../src/context/redaction.js";

// DESIGN §7.3 plus the false-positive cases that keep the rules from eating
// ordinary commands. A redactor that eats `git checkout main` is worse than one
// that misses a token, so every rule below has both halves.

const SECRETS: readonly [string, string][] = [
  ["an OpenAI-style key", "export OPENAI_KEY=sk-abcdefghijklmnopqrstuvwx"],
  [
    "a GitHub token",
    "git clone https://x:y@github.com/o/r#ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
  ],
  [
    "a GitHub oauth token",
    "gh auth login --with-token <<< gho_ABCDEFGHIJKLMNOPQRST",
  ],
  [
    "a Slack token",
    "curl -H 'Authorization: Bearer xoxb-1234567890-abcdefghijkl'",
  ],
  [
    "an AWS access key id",
    "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE",
  ],
  [
    "a Google API key",
    "curl 'https://www.googleapis.com/x?key=AIzaSyA1234567890abcdefghijklmnop'",
  ],
  ["a JWT", "psql $token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP"],
  [
    "a private key block",
    "ssh-keygen <<< $'-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXk=\\n-----END OPENSSH PRIVATE KEY-----'",
  ],
  [
    "a URL with credentials",
    "psql postgres://admin:hunter2@db.internal:5432/app",
  ],
  ["a named assignment", "MY_API_KEY=zzz-secret-value deploy"],
  ["a quoted named assignment", 'export TOKEN="abc123" && ./run'],
  ["a password flag", "mysql -u root --password hunter2 < dump.sql"],
  ["a custom pattern", "deploy --token internal-token-abc123 now"],
];

describe("known token shapes", () => {
  for (const [name, command] of SECRETS) {
    it(`redacts ${name}`, () => {
      const out = redact(command);
      expect(out).toContain("‹redacted›");
      expect(out).not.toBe(command);
    });
  }

  it("keeps the command itself, so the model still knows what ran", () => {
    const out = redact("MY_API_KEY=zzz-secret-value deploy");
    expect(out).toContain("deploy");
    expect(out).toContain("MY_API_KEY=");
  });

  it("preserves the quoting of a value it redacts", () => {
    expect(redact('export TOKEN="abc123"')).toBe('export TOKEN="‹redacted›"');
  });

  it("collapses a multi-line key to one marker", () => {
    const out = redact(
      "-----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB\n-----END RSA PRIVATE KEY-----",
    );
    expect(out).toBe("‹redacted key›");
  });
});

describe("false positives", () => {
  const SAFE: readonly string[] = [
    "git checkout main",
    "ls -la src/",
    "bun run check",
    "npm run build -- --mode production",
    "grep -rn 'authentication' src/",
    "echo 'the key is in the vault'",
    "git log --grep='sk-learn'",
    "docker run -e POSTGRES_PASSWORD_FILE=/run/secrets/pg myimage",
    "cargo build --release",
    "cat sk-README.md",
    "ssh-keygen -t ed25519 -C 'me@example.com'",
    "python -c 'import os; print(os.environ[\"HOME\"])'",
    "sed -i 's/token/X/g' file",
  ];

  for (const command of SAFE) {
    it(`leaves ${JSON.stringify(command)} alone`, () => {
      expect(redact(command)).toBe(command);
    });
  }

  it("leaves a short sk- prefix that is really a word", () => {
    expect(redact("grep sk-short src")).toBe("grep sk-short src");
  });
});

describe("the redactor's own options", () => {
  it("is a no-op when redaction is switched off", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwx";
    expect(redact(secret, { enabled: false })).toBe(secret);
  });

  it("is a no-op on an empty string", () => {
    expect(redact("")).toBe("");
  });

  it("applies a user pattern from config", () => {
    const out = redact("deploy internal-token-abc123", {
      patterns: ["(?i)internal-token-[a-z0-9]+"],
    });
    expect(out).toBe("deploy ‹redacted›");
  });

  it("drops a user pattern that does not compile instead of crashing", () => {
    const redactor = new Redactor({ patterns: ["([unclosed"] });
    expect(redactor.redact("nothing to see")).toBe("nothing to see");
  });

  it("reuses one instance across many commands", () => {
    const redactor = new Redactor();
    expect(redactor.redact("AKIAIOSFODNN7EXAMPLE")).toBe("‹redacted›");
    expect(redactor.redact("ls")).toBe("ls");
  });
});
