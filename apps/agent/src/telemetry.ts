import { createHash } from "node:crypto";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { maskDeep } from "@taxxy/integrations";
import type { Env } from "./config.js";

let processor: LangfuseSpanProcessor | undefined;

export function telemetryEnabled(env: Env): boolean {
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

/** Registers the Langfuse span processor once per process. No-op without keys. */
export function initTelemetry(env: Env): boolean {
  if (processor || !telemetryEnabled(env)) return Boolean(processor);
  processor = new LangfuseSpanProcessor({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_BASE_URL,
    environment: env.TAXXY_ENV,
    mask: ({ data }) => maskDeep(data),
  });
  new NodeTracerProvider({ spanProcessors: [processor] }).register();
  return true;
}

export async function flushTelemetry(): Promise<void> {
  await processor?.forceFlush();
}

export async function shutdownTelemetry(): Promise<void> {
  await processor?.shutdown();
}

export interface TurnIdentity {
  userId: string;
  threadId: string;
  taxYear?: number;
  quarter?: number;
  agent?: "orchestrator" | "categorizer" | "receipt-matcher";
  env: string;
}

/** Trace-level attributes for one turn: hashed user, thread as session, business tags, request metadata. */
export function turnAttributes(env: Env, id: TurnIdentity, metadata: Record<string, unknown> = {}) {
  const tags = [
    id.taxYear ? `tax_year:${id.taxYear}` : undefined,
    id.quarter ? `quarter:${id.quarter}` : undefined,
    `agent:${id.agent ?? "orchestrator"}`,
    `env:${id.env}`,
  ].filter((t): t is string => Boolean(t));
  const hashedUser = createHash("sha256").update(id.userId).digest("hex").slice(0, 16);
  return {
    userId: hashedUser,
    sessionId: id.threadId,
    tags,
    metadata,
    environment: id.env,
    version: env.APP_VERSION,
  };
}

/** The LangChain handler nests the graph run under the active `taxxy-turn` observation. */
export function turnCallbacks(env: Env): CallbackHandler[] {
  return telemetryEnabled(env) ? [new CallbackHandler()] : [];
}

/**
 * Runs `fn` inside a root `taxxy-turn` agent observation whose input/output are the user message
 * and the reply (not the raw graph state), with user/session/tags/metadata propagated to every child.
 */
export async function withTurnTrace<T>(
  env: Env,
  attrs: ReturnType<typeof turnAttributes>,
  userMessage: string,
  fn: (setOutput: (text: string) => void) => Promise<T>,
): Promise<T> {
  if (!telemetryEnabled(env)) return fn(() => undefined);
  return startActiveObservation(
    "taxxy-turn",
    (span) =>
      propagateAttributes(attrs, async () => {
        span.update({ input: { role: "user", content: userMessage } });
        return fn((text) => span.update({ output: { role: "assistant", content: text } }));
      }),
    { asType: "agent" },
  );
}
