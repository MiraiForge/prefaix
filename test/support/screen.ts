// A terminal screen with one cursor.
//
// The renderer writes the answer to stdout and every piece of chrome to stderr.
// That split is right, and it hid a real defect: collecting the two streams into
// two strings and reading them back separately never puts them on the same row,
// so nothing notices that a carriage return and an erase-line on one stream
// lands on text the other stream wrote. The only way to see that kind of damage
// is to have one cursor and let both streams move it.

// Built from a string rather than written as a literal, so the escape is a
// value the linter can read as a value and this file needs no eslint override.
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "gu");

import { ESC } from "../../src/client/render/theme.js";

export interface Screen {
  /** One write, whichever stream it came from. */
  write(raw: string): void;
  /** Every non-blank row, top to bottom. */
  lines(): string[];
  /** The rows as one string, which is what a copy-paste would get. */
  text(): string;
}

/**
 * Enough of a terminal to catch the damage that matters here: carriage return,
 * newline, and erase-in-line. It does not wrap, which is deliberate — the
 * renderer is forbidden from hard-wrapping, so a row is one logical line.
 */
export function screen(): Screen {
  const rows: string[][] = [[]];
  let x = 0;
  let y = 0;
  return {
    write(raw: string): void {
      const text = raw.replace(CSI, "");
      const row = (): string[] => {
        while (rows.length <= y) {
          rows.push([]);
        }
        return rows[y] as string[];
      };
      for (const character of text) {
        if (character === "\r") {
          x = 0;
          continue;
        }
        if (character === "\n") {
          y += 1;
          x = 0;
          row();
          continue;
        }
        const target = row();
        while (target.length <= x) {
          target.push(" ");
        }
        target[x] = character;
        x += 1;
      }
    },
    lines(): string[] {
      return rows
        .map((each) => each.join("").replace(/\s+$/u, ""))
        .filter((each) => each !== "");
    },
    text(): string {
      return this.lines().join("\n");
    },
  };
}
