// A trusted, probe-only RPC dialog. No model call, filesystem or command execution.
interface ProbeContext {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, level: string): void;
    setStatus(key: string, value: string): void;
    setEditorText(text: string): void;
  };
}
interface ProbePi {
  on(
    name: string,
    handler: (event: { prompt?: string }, ctx: ProbeContext) => Promise<void>,
  ): void;
}
export default function rpcUiProbe(pi: ProbePi): void {
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.prompt !== "S9 DIALOG") return;
    const choice = await ctx.ui.select("Which branch?", [
      "main",
      "release/2.1",
    ]);
    ctx.ui.notify(`S9 selected ${choice ?? "cancelled"}`, "info");
    ctx.ui.setStatus("s9", "dialog complete");
    ctx.ui.setEditorText("echo suggestion-waits-for-enter");
  });
}
