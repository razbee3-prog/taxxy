// Runs experiments/tier3-gate.ts locally against the hosted dataset (same contract as langfuse/experiment-action).
// Usage: pnpm --filter @taxxy/agent tier3:experiment   (LANGFUSE_* keys; TIER3_MODE=agent for the LLM run)
import type { RunnerContext } from "@langfuse/client";
import { langfuseClient } from "@taxxy/evals";
import { experiment } from "../../experiments/tier3-gate.js";
import { env } from "../config.js";
import { flushTelemetry, initTelemetry } from "../telemetry.js";

const lf = langfuseClient();
if (!lf) {
  console.error("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set");
  process.exit(1);
}
initTelemetry(env);
const dataset = await lf.dataset.get("taxxy-tier3-profiles");
const context = {
  runExperiment: (cfg: Parameters<typeof dataset.runExperiment>[0]) => dataset.runExperiment(cfg),
} as unknown as RunnerContext;
try {
  const result = await experiment(context);
  console.log(await result.format());
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await Promise.all([lf.flush(), flushTelemetry()]);
}
