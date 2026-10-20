import type { TaxxyAgent } from "./agent.js";
import type { Env } from "./config.js";
import { flushTelemetry, turnCallbacks } from "./telemetry.js";

export interface TurnRequest {
  userId: string;
  threadId: string;
  message: string;
  taxYear?: number;
  quarter?: number;
}

export interface TurnEvent {
  type: "token" | "message" | "done" | "error";
  content?: string;
  error?: string;
}

/** Streams one user turn. `userId` always comes from the caller (session), never from the model. */
export async function* runTurn(
  agent: TaxxyAgent,
  env: Env,
  req: TurnRequest,
): AsyncGenerator<TurnEvent> {
  const callbacks = turnCallbacks(env, {
    userId: req.userId,
    threadId: req.threadId,
    taxYear: req.taxYear,
    quarter: req.quarter,
    env: env.TAXXY_ENV,
  });
  const config = {
    configurable: { thread_id: req.threadId, user_id: req.userId },
    callbacks,
    runName: "taxxy-turn",
    metadata: { user_id: req.userId },
  };
  try {
    const stream = await agent.stream(
      { messages: [{ role: "user", content: req.message }] },
      { ...config, streamMode: "messages" },
    );
    let text = "";
    for await (const chunk of stream) {
      const [msg] = chunk as [unknown, unknown];
      const content = extractText(msg);
      if (content) {
        text += content;
        yield { type: "token", content };
      }
    }
    yield { type: "message", content: text };
    yield { type: "done" };
  } catch (err) {
    yield { type: "error", error: err instanceof Error ? err.message : String(err) };
  } finally {
    await flushTelemetry();
  }
}

function extractText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as {
    type?: string;
    getType?: () => string;
    content?: unknown;
    tool_call_chunks?: unknown[];
  };
  const type = typeof m.getType === "function" ? m.getType() : m.type;
  if (type && type !== "ai" && type !== "AIMessageChunk") return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b) =>
        b && typeof b === "object" && (b as { type?: string }).type === "text"
          ? ((b as { text?: string }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}
