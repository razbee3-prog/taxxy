import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { buildAgent } from "./agent.js";
import { env } from "./config.js";
import { runTurn } from "./run.js";
import { initTelemetry } from "./telemetry.js";

const tracing = initTelemetry(env);
const agent = buildAgent({ env });

const runBody = z.object({
  userId: z.string().min(1),
  message: z.string().min(1),
  taxYear: z.number().int().optional(),
  quarter: z.number().int().min(1).max(4).optional(),
});

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, tracing, model: env.ORCHESTRATOR_MODEL }));

app.post("/threads/:threadId/runs", async (c) => {
  const parsed = runBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const threadId = c.req.param("threadId");
  return streamSSE(c, async (stream) => {
    for await (const ev of runTurn(agent, env, { ...parsed.data, threadId })) {
      await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
    }
  });
});

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`taxxy agent listening on :${info.port} (tracing ${tracing ? "on" : "off"})`);
  });
}
