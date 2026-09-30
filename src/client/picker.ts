import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrefaixError } from "../core/errors.js";
import { TtyController, installExitGuards, type RawModeTarget } from "./tty.js";
import { executable, plain } from "./process.js";

export interface PickItem {
  id: string;
  label: string;
  preview?: string;
}
export interface PickerOptions {
  items: readonly PickItem[];
  title: string;
  mode: "auto" | "builtin";
  env: Readonly<Record<string, string | undefined>>;
  out: (text: string) => void;
  tty?: RawModeTarget;
  rows?: number;
  cols?: number;
}

export async function pick(
  options: PickerOptions,
): Promise<string | undefined> {
  if (options.items.length === 0) return undefined;
  const fzf =
    options.mode === "auto" ? executable("fzf", options.env) : undefined;
  return fzf === undefined ? builtin(options) : external(fzf, options);
}

async function external(
  bin: string,
  options: PickerOptions,
): Promise<string | undefined> {
  const { spawn } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "prefaix-picker-"));
  try {
    await Promise.all(
      options.items.map((item, index) =>
        writeFile(
          join(directory, String(index)),
          (item.preview ?? item.label).split("\n").map(plain).join("\n"),
          {
            mode: 0o600,
          },
        ),
      ),
    );
    // Only a generated directory and a validated numeric field enter the preview
    // command. Conversation text is file content, never shell source.
    const preview = `cat -- '${directory.replaceAll("'", "'\\''")}'/{1}`;
    const selection = await new Promise<string | undefined>(
      (resolve, reject) => {
        const child = spawn(
          bin,
          [
            "--read0",
            "--print0",
            "--delimiter=\t",
            "--with-nth=2..",
            `--prompt=${plain(options.title)}> `,
            `--preview=${preview}`,
          ],
          {
            env: {
              ...options.env,
              FZF_DEFAULT_OPTS: "",
              FZF_DEFAULT_OPTS_FILE: "",
              FZF_DEFAULT_COMMAND: "",
            },
            stdio: ["pipe", "pipe", "inherit"],
          },
        );
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (text: string) => {
          output += text;
        });
        child.stdin.on("error", () => undefined);
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 1 || code === 130) {
            resolve(undefined);
            return;
          }
          if (code !== 0) {
            reject(
              new PrefaixError("AGENT_ERROR", "fzf could not open the picker"),
            );
            return;
          }
          const index = output.split("\t", 1)[0] ?? "";
          resolve(
            /^\d+$/u.test(index) ? options.items[Number(index)]?.id : undefined,
          );
        });
        child.stdin.end(
          options.items
            .map((item, index) => `${String(index)}\t${plain(item.label)}\0`)
            .join(""),
        );
      },
    );
    return selection;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function builtin(options: PickerOptions): Promise<string | undefined> {
  if (options.tty === undefined && process.stdin.isTTY !== true) {
    throw new PrefaixError(
      "USAGE",
      "this picker needs an interactive terminal; supply a name or id",
    );
  }
  let selected = 0;
  let query = "";
  let matches = [...options.items];
  let finish: (value: string | undefined) => void = () => undefined;
  const result = new Promise<string | undefined>((resolve) => {
    finish = resolve;
  });
  const height = Math.max(
    3,
    Math.min(16, (options.rows ?? process.stdout.rows ?? 24) - 1),
  );
  const width = Math.max(8, (options.cols ?? process.stdout.columns ?? 80) - 1);
  const draw = (): void => {
    const preview = matches[selected]?.preview?.split("\n") ?? [];
    const previewRows = Math.min(preview.length, Math.max(0, height - 5), 5);
    const listRows = height - previewRows - 2;
    const from = Math.max(0, selected - listRows + 1);
    const lines = [`${plain(options.title)}: ${plain(query)}`];
    for (const [index, item] of matches
      .slice(from, from + listRows)
      .entries()) {
      lines.push(
        `${index + from === selected ? "›" : " "} ${plain(item.label)}`,
      );
    }
    while (lines.length < height - previewRows - 1) lines.push("");
    lines.push(...preview.slice(0, previewRows).map(plain));
    lines.push("↑↓ · Enter select · Esc cancel");
    options.out(
      `\u001b8\r\u001b[J${lines.map((line) => clip(line, width)).join("\r\n")}`,
    );
  };
  const tty = new TtyController({
    ...(options.tty === undefined ? {} : { input: options.tty }),
    onEsc: () => finish(undefined),
    onKey: (key) => {
      if (key.name === "ctrl-c" || key.name === "ctrl-d") finish(undefined);
      else if (key.name === "enter") finish(matches[selected]?.id);
      else {
        if (key.name === "up") selected = Math.max(0, selected - 1);
        else if (key.name === "down")
          selected = Math.min(matches.length - 1, selected + 1);
        else if (key.name === "char" || key.name === "backspace") {
          query =
            key.name === "backspace"
              ? Array.from(query).slice(0, -1).join("")
              : query + key.text;
          matches = options.items.filter((item) =>
            item.label.toLowerCase().includes(query.toLowerCase()),
          );
          selected = 0;
        }
        draw();
      }
    },
  });
  const release = installExitGuards(() => {
    tty.restore();
    finish(undefined);
  });
  try {
    tty.enter();
    if (!tty.raw)
      throw new PrefaixError(
        "USAGE",
        "could not enter raw mode for the picker",
      );
    // Reserve the inline region before saving its origin. This avoids saving a
    // bottom-row cursor that would move out from under us on the first redraw.
    options.out(
      `${"\r\n".repeat(height - 1)}\u001b[${String(height - 1)}A\r\u001b7`,
    );
    draw();
    return await result;
  } finally {
    release();
    tty.restore();
    options.out("\r\n");
  }
}

function clip(text: string, width: number): string {
  let used = 0;
  let result = "";
  for (const character of text) {
    // Counting non-ASCII conservatively as two cells also bounds emoji/CJK
    // without importing a Unicode table into the client's startup path.
    const cells = character.codePointAt(0)! > 127 ? 2 : 1;
    if (used + cells > width - 1) return `${result}…`;
    result += character;
    used += cells;
  }
  return result;
}
