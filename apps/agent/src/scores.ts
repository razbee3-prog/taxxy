import { LangfuseClient } from "@langfuse/client";
import type { Env } from "./config.js";
import { telemetryEnabled } from "./telemetry.js";

let client: LangfuseClient | null | undefined;

function langfuse(env: Env): LangfuseClient | null {
  if (client !== undefined) return client;
  client = telemetryEnabled(env)
    ? new LangfuseClient({
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        baseUrl: env.LANGFUSE_BASE_URL,
      })
    : null;
  return client;
}

/** Outcome signals named after the observed event (not a quality judgement), attached to the thread's session. */
export type OutcomeSignal =
  | "estimate_accepted"
  | "estimate_edited"
  | "review_label_overridden"
  | "bank_relink_required";

export function recordOutcome(
  env: Env,
  signal: OutcomeSignal,
  ctx: { threadId?: string; comment?: string; metadata?: Record<string, unknown> },
): void {
  const lf = langfuse(env);
  if (!lf) return;
  lf.score.create({
    name: signal,
    value: 1,
    dataType: "BOOLEAN",
    sessionId: ctx.threadId,
    comment: ctx.comment,
    metadata: ctx.metadata,
    environment: env.TAXXY_ENV,
  });
}

export async function flushScores(): Promise<void> {
  await client?.flush();
}
