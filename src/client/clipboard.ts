import { PrefaixError } from "../core/errors.js";
import { executable } from "./process.js";

export async function copyText(
  text: string,
  options: {
    env: Readonly<Record<string, string | undefined>>;
    out: (text: string) => void;
    isTty: boolean;
  },
): Promise<string> {
  const candidates: [string, string[]][] = [
    ["pbcopy", []],
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
  ];
  for (const [name, args] of candidates) {
    const bin = executable(name, options.env);
    if (bin === undefined) continue;
    const { spawn } = await import("node:child_process");
    const copied = await new Promise<boolean>((resolve) => {
      const child = spawn(bin, args, {
        env: { ...options.env },
        stdio: ["pipe", "ignore", "ignore"],
      });
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 2000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(text);
    });
    if (copied) return name;
  }
  if (!options.isTty || options.env["TERM"] === "dumb")
    throw new PrefaixError(
      "USAGE",
      "no clipboard tool is available; install pbcopy, wl-copy, or xclip",
    );
  options.out(`\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`);
  return "OSC 52";
}
