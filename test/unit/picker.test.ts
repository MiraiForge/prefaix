import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import headless from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { pick, type PickerOptions } from "../../src/client/picker.js";
import { copyText } from "../../src/client/clipboard.js";
import { executable, plain } from "../../src/client/process.js";
import type { RawModeTarget } from "../../src/client/tty.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-pick-test-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});
function script(name: string, body: string) {
  writeFileSync(join(home, name), `#!${process.execPath}\n${body}`, {
    mode: 0o700,
  });
}
function tty() {
  let onData: ((text: string) => void) | undefined;
  const modes: boolean[] = [];
  const input: RawModeTarget = {
    setRawMode: (mode) => {
      modes.push(mode);
      return mode;
    },
    on: (_, fn) => {
      onData = fn;
    },
    removeAllListeners: () => {
      onData = undefined;
    },
    pause: vi.fn(),
  };
  return { input, modes, send: (text: string) => onData?.(text) };
}
function options(overrides: Partial<PickerOptions> = {}): PickerOptions {
  return {
    title: "Choose",
    items: [
      {
        id: "a",
        label: "Alpha",
        preview: "Title: Alpha\nRoot: /x\nLast turn: hello",
      },
      { id: "b", label: "Beta" },
    ],
    mode: "auto",
    env: { PATH: home },
    out: () => undefined,
    ...overrides,
  };
}
describe("built-in picker", () => {
  it("selects arrows and filtering, renders previews, and restores raw mode", async () => {
    const terminal = tty();
    const out: string[] = [];
    const result = pick(
      options({ tty: terminal.input, out: (text) => out.push(text) }),
    );
    terminal.send("\t");
    terminal.send("\u001b[B");
    terminal.send("\u001b[A");
    terminal.send("b");
    terminal.send("\u007f");
    terminal.send("🙂");
    terminal.send("\u007f");
    terminal.send("B\r");
    expect(await result).toBe("b");
    expect(terminal.modes).toEqual([true, false]);
    expect(out.join("")).toContain("Last turn: hello");
    expect(terminal.input.pause).toHaveBeenCalledOnce();
  });
  it.each(["\u001b", "\u0003", "\u0004"])(
    "cancels on %j and restores the terminal",
    async (key) => {
      const terminal = tty();
      const result = pick(options({ tty: terminal.input, mode: "builtin" }));
      terminal.send(key);
      expect(await result).toBeUndefined();
      expect(terminal.modes).toEqual([true, false]);
    },
  );
  it("restores and cancels through the installed termination guard", async () => {
    const terminal = tty();
    const before = process.listeners("SIGTERM");
    const pending = pick(options({ tty: terminal.input }));
    const guard = process
      .listeners("SIGTERM")
      .find((listener) => !before.includes(listener));
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    try {
      guard?.("SIGTERM");
      expect(await pending).toBeUndefined();
      expect(terminal.modes).toEqual([true, false]);
      expect(exit).toHaveBeenCalledWith(130);
      expect(process.listeners("SIGTERM")).toEqual(before);
    } finally {
      exit.mockRestore();
    }
  });
  it("preserves an already raw tty", async () => {
    const terminal = tty();
    terminal.input.isRaw = true;
    const pending = pick(options({ tty: terminal.input }));
    terminal.send("\r");
    expect(await pending).toBe("a");
    expect(terminal.modes).toEqual([true, true]);
  });
  it("redraws one bounded list without scrolling on a short, narrow terminal", async () => {
    const terminal = tty();
    const { Terminal } = headless as unknown as {
      Terminal: typeof HeadlessTerminal;
    };
    const screen = new Terminal({
      rows: 8,
      cols: 36,
      scrollback: 100,
      allowProposedApi: true,
    });
    const output: string[] = [];
    const pending = pick(
      options({
        tty: terminal.input,
        rows: 8,
        cols: 36,
        out: (text) => output.push(text),
        items: Array.from({ length: 14 }, (_, index) => ({
          id: String(index),
          label: `Item ${String(index)} ` + "日本語".repeat(30),
          preview: "long preview\n".repeat(30),
        })),
      }),
    );
    const write = (value: string) =>
      new Promise<void>((resolve) => screen.write(value, resolve));
    await write(output.splice(0).join(""));
    const base = screen.buffer.active.baseY;
    terminal.send("\u001b[B".repeat(12));
    await write(output.splice(0).join(""));
    expect(screen.buffer.active.baseY).toBe(base);
    const text = Array.from(
      { length: screen.buffer.active.length },
      (_, row) =>
        screen.buffer.active.getLine(row)?.translateToString(true) ?? "",
    ).join("\n");
    expect(text.match(/Choose:/gu)).toHaveLength(1);
    expect(text).toContain("Enter select · Esc cancel");
    expect(text).toContain("› Item 12");
    expect(text.match(/long preview/gu)).toHaveLength(2);
    terminal.send("\r");
    expect(await pending).toBe("12");
    screen.dispose();
  });
  it("can navigate beyond the first screen of results", async () => {
    const terminal = tty();
    const result = pick(
      options({
        tty: terminal.input,
        items: Array.from({ length: 14 }, (_, index) => ({
          id: String(index),
          label: String(index),
        })),
      }),
    );
    terminal.send("\u001b[B".repeat(13) + "\r");
    expect(await result).toBe("13");
  });
  it("handles an empty list and an empty filtered result", async () => {
    expect(await pick(options({ items: [] }))).toBeUndefined();
    const terminal = tty();
    const result = pick(options({ tty: terminal.input }));
    terminal.send("xyz\r");
    expect(await result).toBeUndefined();
  });
  it("reports missing or failed tty and restores on render errors", async () => {
    await expect(pick(options())).rejects.toThrow(/interactive terminal/u);
    const terminal = tty();
    terminal.input.setRawMode = () => {
      throw new Error("gone");
    };
    await expect(pick(options({ tty: terminal.input }))).rejects.toThrow(
      /raw mode/u,
    );
    const second = tty();
    await expect(
      pick(
        options({
          tty: second.input,
          out: () => {
            throw new Error("output failed");
          },
        }),
      ),
    ).rejects.toThrow("output failed");
    expect(second.modes).toEqual([true, false]);
  });
});
describe("fzf picker", () => {
  it("uses only numeric selectors and preview files while preserving literal hostile text", async () => {
    const capture = join(home, "capture.json");
    script(
      "fzf",
      `const fs = require('node:fs'); let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const arg = process.argv.find(a => a.startsWith('--preview=')); const directory = arg.match(/cat -- '(.*)'/)[1]; fs.writeFileSync(process.env.CAPTURE, JSON.stringify({input,args:process.argv,preview:fs.readFileSync(directory + '/0','utf8'),directory,opts:process.env.FZF_DEFAULT_OPTS})); process.stdout.write(input.split('\\0')[0]+'\\0'); });`,
    );
    const hostile = "$(touch owned) `evil` '; exit 9;";
    expect(
      await pick(
        options({
          env: {
            PATH: home,
            CAPTURE: capture,
            FZF_DEFAULT_OPTS: "--bind=enter:execute(evil)",
          },
          items: [{ id: "safe", label: hostile, preview: "Title: " + hostile }],
        }),
      ),
    ).toBe("safe");
    const result = JSON.parse(readFileSync(capture, "utf8")) as {
      input: string;
      preview: string;
      directory: string;
      opts: string;
    };
    expect(result.input).toContain(hostile);
    expect(result.preview).toBe("Title: " + hostile);
    expect(result.opts).toBe("");
    expect(existsSync(result.directory)).toBe(false);
  });
  it.each([1, 130])("treats fzf exit %i as cancellation", async (code) => {
    script("fzf", `process.exit(${String(code)})`);
    expect(await pick(options())).toBeUndefined();
  });
  it("reports a failing executable and does not accept foreign selections", async () => {
    script("fzf", "process.exit(2)");
    await expect(pick(options())).rejects.toThrow(/fzf/u);
    script("fzf", "process.stdout.write('foreign\\tAlpha\\0')");
    expect(await pick(options())).toBeUndefined();
    script("fzf", "process.stdout.write('99\\tAlpha\\0')");
    expect(await pick(options())).toBeUndefined();
    writeFileSync(join(home, "fzf"), "#!/does/not/exist\n", { mode: 0o700 });
    await expect(pick(options())).rejects.toThrow();
  });
});
describe("clipboard", () => {
  it.each(["pbcopy", "wl-copy", "xclip"])(
    "copies literal content with %s",
    async (name) => {
      const capture = join(home, "copy");
      script(
        name,
        "const fs=require('node:fs');let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>fs.writeFileSync(process.env.CAPTURE,text));",
      );
      const text = "quote'\n$(touch evil)\n日本語";
      expect(
        await copyText(text, {
          env: { PATH: home, CAPTURE: capture },
          out: () => undefined,
          isTty: false,
        }),
      ).toBe(name);
      expect(readFileSync(capture, "utf8")).toBe(text);
    },
  );
  it("falls back after a failing tool and encodes OSC52 only on a usable tty", async () => {
    script("pbcopy", "process.exit(1)");
    const output: string[] = [];
    expect(
      await copyText("日本語", {
        env: { PATH: home },
        out: (text) => output.push(text),
        isTty: true,
      }),
    ).toBe("OSC 52");
    expect(output.join("")).toBe(
      `\u001b]52;c;${Buffer.from("日本語").toString("base64")}\u0007`,
    );
    await expect(
      copyText("x", {
        env: { PATH: home },
        out: () => undefined,
        isTty: false,
      }),
    ).rejects.toThrow(/clipboard tool/u);
    await expect(
      copyText("x", {
        env: { TERM: "dumb" },
        out: () => undefined,
        isTty: true,
      }),
    ).rejects.toThrow(/clipboard tool/u);
  });
  it("skips an unlaunchable tool and terminates a stuck one", async () => {
    writeFileSync(join(home, "pbcopy"), "#!/does/not/exist\n", { mode: 0o700 });
    expect(
      await copyText("x", {
        env: { PATH: home },
        out: () => undefined,
        isTty: true,
      }),
    ).toBe("OSC 52");
    script("pbcopy", "setInterval(()=>{},1000)");
    expect(
      await copyText("x", {
        env: { PATH: home },
        out: () => undefined,
        isTty: true,
      }),
    ).toBe("OSC 52");
  });
  it("ignores empty PATH components and terminal controls", () => {
    expect(
      executable("no-such-command", { PATH: `:${home}:` }),
    ).toBeUndefined();
    expect(plain("one\u001b\n\0two")).toBe("one   two");
  });
});
