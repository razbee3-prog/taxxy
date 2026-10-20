import { createHash } from "node:crypto";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
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

/** One handler per turn; it becomes the trace for that turn. */
export function turnCallbacks(env: Env, id: TurnIdentity): CallbackHandler[] {
  if (!telemetryEnabled(env)) return [];
  const tags = [
    id.taxYear ? `tax_year:${id.taxYear}` : undefined,
    id.quarter ? `quarter:${id.quarter}` : undefined,
    `agent:${id.agent ?? "orchestrator"}`,
    `env:${id.env}`,
  ].filter((t): t is string => Boolean(t));
  const hashedUser = createHash("sha256").update(id.userId).digest("hex").slice(0, 16);
  return [new CallbackHandler({ userId: hashedUser, sessionId: id.threadId, tags })];
}
