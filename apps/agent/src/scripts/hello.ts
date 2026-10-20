import { env } from "../config.js";
import { buildDeps } from "../deps.js";
import { runTurn } from "../run.js";
import { initTelemetry, shutdownTelemetry } from "../telemetry.js";

const tracing = initTelemetry(env);
const deps = await buildDeps(env);
let reply = "";
for await (const ev of runTurn(deps, {
  userId: "hello-user",
  message: process.argv[2] ?? "Hello Taxxy, what can you do?",
})) {
  if (ev.type === "message") reply = ev.content ?? "";
  if (ev.type === "error") throw new Error(ev.error);
}
console.log(reply);
console.log(
  `\n[tracing ${tracing ? "on: check Langfuse for trace 'taxxy-turn'" : "off: LANGFUSE_* not set"}]`,
);
await shutdownTelemetry();
process.exit(0);
