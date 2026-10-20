import { buildAgent } from "../agent.js";
import { env } from "../config.js";
import { runTurn } from "../run.js";
import { initTelemetry, shutdownTelemetry } from "../telemetry.js";

const tracing = initTelemetry(env);
const agent = buildAgent({ env });
let reply = "";
for await (const ev of runTurn(agent, env, {
  userId: "hello-user",
  threadId: `hello:${Date.now()}`,
  message: "Hello Taxxy, what can you do?",
})) {
  if (ev.type === "message") reply = ev.content ?? "";
  if (ev.type === "error") throw new Error(ev.error);
}
console.log(reply);
console.log(
  `\n[tracing ${tracing ? "on: check Langfuse for trace 'taxxy-turn'" : "off: LANGFUSE_* not set"}]`,
);
await shutdownTelemetry();
