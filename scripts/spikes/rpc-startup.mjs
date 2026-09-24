import { spawn } from "node:child_process";

const extra = process.argv.slice(2);
const t0 = performance.now();
const child = spawn("pi", ["--mode", "rpc", "--no-session", "--offline", ...extra], {
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
let stderrBytes = 0;
child.stderr.on("data", (c) => (stderrBytes += c.length));
child.stdout.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log("non-json stdout:", line.slice(0, 120));
      continue;
    }
    if (msg.type === "response" && msg.id === "s1") {
      const ms = Math.round(performance.now() - t0);
      const d = msg.data ?? {};
      console.log(
        JSON.stringify({
          ms,
          stderrBytes,
          model: d.model ? `${d.model.provider}/${d.model.id}` : null,
          thinking: d.thinkingLevel,
          keys: Object.keys(d),
        }),
      );
      child.stdin.end();
    } else if (msg.type !== "response") {
      console.log("pre-ready record:", msg.type, msg.method ?? "");
    }
  }
});
child.on("exit", (code) => {
  console.log("exit", code, "after", Math.round(performance.now() - t0), "ms");
});
child.stdin.write(JSON.stringify({ id: "s1", type: "get_state" }) + "\n");
