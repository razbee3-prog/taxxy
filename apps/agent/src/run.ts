import { threadId as makeThreadId } from "@taxxy/db";
import { ENGINE_VERSION } from "@taxxy/engine";
import { buildAgent } from "./agent.js";
import type { AppDeps } from "./deps.js";
import { flushScores } from "./scores.js";
import { flushTelemetry, turnAttributes, turnCallbacks, withTurnTrace } from "./telemetry.js";

export interface TurnRequest {
  userId: string;
  threadId?: string;
  message: string;
  taxYear?: number;
  quarter?: number;
}

export interface TurnEvent {
  type: "token" | "message" | "interrupt" | "done" | "error";
  content?: string;
  error?: string;
  interrupt?: unknown;
  threadId?: string;
}

/** Streams one user turn. `userId` always comes from the caller (session), never from the model. */
export async function* runTurn(deps: AppDeps, req: TurnRequest): AsyncGenerator<TurnEvent> {
  const env = deps.env;
  const taxYear = req.taxYear ?? new Date().getUTCFullYear();
  const quarter = req.quarter ?? Math.min(4, Math.floor(new Date().getUTCMonth() / 3) + 1);
  const threadId = req.threadId ?? makeThreadId(req.userId, taxYear, quarter);
  const metadata = {
    tax_year: taxYear,
    quarter,
    thread_id: threadId,
    app_version: env.APP_VERSION,
    orchestrator_model: env.ORCHESTRATOR_MODEL,
    categorizer_model: env.CATEGORIZER_MODEL,
    engine_version: ENGINE_VERSION,
  };
  const attrs = turnAttributes(
    env,
    { userId: req.userId, threadId, taxYear, quarter, env: env.TAXXY_ENV },
    metadata,
  );
  const config = {
    configurable: { thread_id: threadId, user_id: req.userId, tax_year: taxYear, quarter },
    callbacks: turnCallbacks(env),
    runName: "run-orchestrator",
    tags: attrs.tags,
    metadata,
    recursionLimit: 60,
  };
  try {
    const agent = await buildAgent({ deps, userId: req.userId });
    const queue: TurnEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let failure: unknown;
    let text = "";
    const push = (ev: TurnEvent) => {
      queue.push(ev);
      wake?.();
      wake = null;
    };
    void withTurnTrace(env, attrs, req.message, async (setOutput) => {
      const stream = await agent.stream(
        { messages: [{ role: "user", content: req.message }] },
        { ...config, streamMode: ["messages", "updates"] },
      );
      for await (const chunk of stream) {
        const [mode, payload] = chunk as [string, unknown];
        if (mode === "messages") {
          const [msg] = payload as [unknown, unknown];
          const content = extractText(msg);
          if (content) {
            text += content;
            push({ type: "token", content });
          }
        } else if (mode === "updates") {
          const u = payload as Record<string, unknown>;
          if (u.__interrupt__) push({ type: "interrupt", interrupt: u.__interrupt__, threadId });
        }
      }
      setOutput(text);
    })
      .catch((err: unknown) => {
        failure = err;
      })
      .finally(() => {
        done = true;
        wake?.();
        wake = null;
      });
    while (!done || queue.length) {
      const ev = queue.shift();
      if (ev) {
        yield ev;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    if (failure) throw failure;
    yield { type: "message", content: text, threadId };
    yield { type: "done", threadId };
  } catch (err) {
    yield { type: "error", error: err instanceof Error ? err.message : String(err), threadId };
  } finally {
    await Promise.all([flushTelemetry(), flushScores()]);
  }
}

export function extractText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as { type?: string; getType?: () => string; content?: unknown; name?: string };
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
