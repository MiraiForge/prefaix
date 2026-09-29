import { describe, expect, it } from "vitest";
import {
  formatDiagnostic,
  locatePath,
  renderDiagnostics,
} from "../../src/core/config/diagnostics.js";
import {
  envDiagnostic,
  fileDiagnostic,
} from "../../src/core/config/diagnostics.js";

const DOC = `# a leading comment
[agent]
backend = "pi"
agent.pi.bin = "pi"
extra = 1

[agent.pi]
bin = "pi"

[personas."my persona"]
guideline = "Be brief."

[context]
# trailing comment
recent_commands = 10
`;

describe("locating a key in the source", () => {
  it("finds a key under its own table", () => {
    expect(locatePath(DOC, "agent.backend")).toEqual({ line: 3, column: 1 });
    expect(locatePath(DOC, "agent.pi.bin")).toEqual({ line: 8, column: 1 });
    expect(locatePath(DOC, "context.recent_commands")).toEqual({
      line: 15,
      column: 1,
    });
  });

  it("finds a dotted key written before any table", () => {
    expect(locatePath(DOC, "agent.extra")).toEqual({ line: 5, column: 1 });
  });

  it("finds a key in a quoted table name", () => {
    // The header's quotes are stripped, so the path matches the unquoted name.
    expect(locatePath(DOC, "personas.my persona.guideline")).toEqual({
      line: 11,
      column: 1,
    });
  });

  it("falls back to the containing table when the key is absent", () => {
    // A typo points at its table, which is more useful than line 1.
    expect(locatePath(DOC, "agent.max_childern")).toEqual({
      line: 2,
      column: 1,
    });
  });

  it("finds a top-level key with no table", () => {
    expect(locatePath("color = true\n", "color")).toEqual({
      line: 1,
      column: 1,
    });
  });

  it("returns nothing for a path the source never mentions", () => {
    expect(locatePath(DOC, "nosuch.key")).toBeUndefined();
  });

  it("returns nothing for an empty or malformed path", () => {
    expect(locatePath(DOC, "")).toBeUndefined();
    expect(locatePath(DOC, ".")).toBeUndefined();
  });

  it("ignores a line that is itself a table header", () => {
    const doc = "[a]\nb = 1\n[a.b]\nc = 2\n";
    // "b" resolves to its assignment, not to the [a.b] header line.
    expect(locatePath(doc, "a.b")).toEqual({ line: 2, column: 1 });
    expect(locatePath(doc, "a.b.c")).toEqual({ line: 4, column: 1 });
  });

  it("finds a key with spaces around its equals", () => {
    expect(locatePath("[a]\nb   =   1\n", "a.b")).toEqual({
      line: 2,
      column: 1,
    });
  });

  it("finds a quoted assignment key", () => {
    expect(locatePath('[a]\n"my key" = 1\n', "a.my key")).toEqual({
      line: 2,
      column: 1,
    });
  });

  it("prefers the later table when one name repeats", () => {
    const doc = "[a]\nx = 1\n[b]\n[a]\nx = 2\n";
    expect(locatePath(doc, "a.x")).toEqual({ line: 5, column: 1 });
  });

  it("handles a header with a trailing comment", () => {
    expect(locatePath("[a] # note\nx = 1\n", "a.x")).toEqual({
      line: 2,
      column: 1,
    });
  });

  it("handles an array-of-tables header", () => {
    // A path under [[a]] is unusual but must not throw.
    expect(() => locatePath("[[a]]\nx = 1\n", "a.x")).not.toThrow();
  });
});

describe("formatting a diagnostic", () => {
  it("names the file, line, and column", () => {
    expect(
      formatDiagnostic(fileDiagnostic("pool.max", "bad", 4, 3), "/tmp/c.toml"),
    ).toBe("/tmp/c.toml:4:3: pool.max: bad");
  });

  it("defaults the column to 1 and falls back to config.toml", () => {
    expect(formatDiagnostic(fileDiagnostic("pool", "bad", 4, null))).toBe(
      "config.toml:4:1: pool: bad",
    );
  });

  it("names the env var for an override, with no position", () => {
    expect(
      formatDiagnostic(
        envDiagnostic("pool.max", "PREFAIX_POOL_MAX", "bad"),
        "/tmp/c.toml",
      ),
    ).toBe("PREFAIX_POOL_MAX: pool.max: bad");
  });

  it("has no key prefix for a document-level problem", () => {
    expect(formatDiagnostic(fileDiagnostic("", "bad TOML", 1, 1))).toBe(
      "config.toml:1:1: bad TOML",
    );
  });
});

describe("rendering diagnostics", () => {
  it("shows the source line and a caret under the column", () => {
    const text = '[pool]\nmax_children = "6"\n';
    const rendered = renderDiagnostics(
      [fileDiagnostic("pool.max_children", "expected a number", 2, 15)],
      { file: "/tmp/c.toml", text },
    );
    expect(rendered).toBe(
      "/tmp/c.toml:2:15: pool.max_children: expected a number\n" +
        'max_children = "6"\n' +
        "              ^",
    );
  });

  it("clamps a caret beyond the end of its line", () => {
    const text = "a = \n";
    const rendered = renderDiagnostics(
      [fileDiagnostic("a", "invalid value", 1, 99)],
      { file: "/tmp/c.toml", text },
    );
    expect(rendered.split("\n")[2]).toBe(`${" ".repeat(98)}^`);
  });

  it("omits the snippet when the line is not in the given text", () => {
    const rendered = renderDiagnostics([fileDiagnostic("a", "bad", 9, 1)], {
      file: "/tmp/c.toml",
      text: "a = 1\n",
    });
    expect(rendered).toBe("/tmp/c.toml:9:1: a: bad");
  });

  it("reuses the parser's own message for a document-level problem", () => {
    // pi's and smol-toml's messages already carry a codeblock with a caret.
    const rendered = renderDiagnostics(
      [fileDiagnostic("", "Invalid TOML document: invalid value", 2, 7)],
      { file: "/tmp/c.toml", text: "a = \n" },
    );
    expect(rendered).toBe(
      "/tmp/c.toml:2:7: Invalid TOML document: invalid value",
    );
  });

  it("separates problems with a blank line", () => {
    const rendered = renderDiagnostics(
      [fileDiagnostic("a", "one", 1, 1), fileDiagnostic("b", "two", 2, 1)],
      { file: "/tmp/c.toml" },
    );
    expect(rendered).toBe("/tmp/c.toml:1:1: a: one\n\n/tmp/c.toml:2:1: b: two");
  });

  it("works with no options at all", () => {
    expect(renderDiagnostics([fileDiagnostic("a", "bad", 1, 1)])).toBe(
      "config.toml:1:1: a: bad",
    );
  });
});

describe("position lookup, last corners", () => {
  it("handles a single-quoted table name", () => {
    expect(
      locatePath(
        "[personas.'my plan']\ntools = []\n",
        "personas.my plan.tools",
      ),
    ).toEqual({ line: 2, column: 1 });
  });

  it("finds a top-level key when no table matches at all", () => {
    expect(locatePath("[a]\n[b]\nc = 1\n", "c")).toEqual({
      line: 3,
      column: 1,
    });
  });

  it("points at a leading-whitespace assignment", () => {
    expect(locatePath("[a]\n    b = 1\n", "a.b")).toEqual({
      line: 2,
      column: 5,
    });
  });

  it("skips a blank line while looking", () => {
    expect(locatePath("[a]\n\n\nb = 1\n", "a.b")).toEqual({
      line: 4,
      column: 1,
    });
  });

  it("renders a diagnostic whose position is unknown", () => {
    const rendered = renderDiagnostics(
      [fileDiagnostic("a", "bad", null, null)],
      {
        file: "/tmp/c.toml",
        text: "a = 1\n",
      },
    );
    // No position to point at, so the head line stands alone.
    expect(rendered).toBe("/tmp/c.toml: a: bad");
  });

  it("renders a caret at column 1 when none is given", () => {
    const rendered = renderDiagnostics([fileDiagnostic("a", "bad", 1, null)], {
      file: "/tmp/c.toml",
      text: "a = 1\n",
    });
    expect(rendered.split("\n")[2]).toBe("^");
  });
});

describe("position lookup, unterminated values", () => {
  it("handles a path whose last segment is missing from a table", () => {
    expect(locatePath("[a]\n", "a.missing")).toEqual({ line: 1, column: 1 });
  });

  it("finds nothing for a path with no parent at all", () => {
    expect(locatePath("x = 1\n", "x")).toEqual({ line: 1, column: 1 });
    expect(locatePath("a = 1\n", "y")).toBeUndefined();
  });

  it("reads a quoted key with no closing quote in the match", () => {
    // A malformed header must not throw, only fail to match.
    expect(() => locatePath('["a\nb = 1\n', "a.b")).not.toThrow();
  });
});

describe("a header with no closing bracket", () => {
  it("is not treated as a header, so the key is found without one", () => {
    const doc = '["a\nb = 1\n';
    expect(() => locatePath(doc, "a.b")).not.toThrow();
    // No usable header, so the scan finds the assignment itself.
    expect(locatePath(doc, "a.b")).toEqual({ line: 2, column: 1 });
  });
});
