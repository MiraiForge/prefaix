import { join } from "node:path";
import type { AgentCommand } from "../core/agent-port.js";
import { isConversationId } from "../core/ids.js";
import type { PrefaixPaths } from "../core/paths.js";

export function commandAlias(command: AgentCommand): string {
  return command.kind === "skill"
    ? command.name.replace(/^skill:/u, "")
    : command.name;
}

export function commandPrompt(command: AgentCommand, args: string): string {
  const name =
    command.kind === "skill" ? `skill:${commandAlias(command)}` : command.name;
  return `/${name}${args === "" ? "" : ` ${args}`}`;
}

export async function cacheCommands(
  paths: PrefaixPaths,
  conversationId: string,
  commands: readonly AgentCommand[],
): Promise<void> {
  if (!isConversationId(conversationId)) return;
  const { mkdir, rename, writeFile } = await import("node:fs/promises");
  const directory = join(paths.runtimeDir, "commands");
  const file = join(directory, `${conversationId}.json`);
  const temp = `${file}.${String(process.pid)}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temp, JSON.stringify(commands), { mode: 0o600 });
    await rename(temp, file);
  } catch {
    /* Optional help metadata must never fail a completed turn. */
  }
}

export async function cachedCommands(
  paths: PrefaixPaths,
  conversationId: string,
): Promise<AgentCommand[]> {
  if (!isConversationId(conversationId)) return [];
  const { readFile } = await import("node:fs/promises");
  try {
    const raw: unknown = JSON.parse(
      await readFile(
        join(paths.runtimeDir, "commands", `${conversationId}.json`),
        "utf8",
      ),
    );
    if (!Array.isArray(raw)) return [];
    return raw.filter((value: unknown): value is AgentCommand => {
      if (typeof value !== "object" || value === null) return false;
      const command = value as Partial<AgentCommand>;
      return (
        typeof command.name === "string" &&
        /^[A-Za-z][A-Za-z0-9:_-]*$/u.test(command.name) &&
        (command.kind === "skill" ||
          command.kind === "template" ||
          command.kind === "extension") &&
        (command.description === undefined ||
          typeof command.description === "string")
      );
    });
  } catch {
    return [];
  }
}
