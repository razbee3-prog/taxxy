import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { env } from "./config.js";
import { type AppDeps, buildDeps } from "./deps.js";
import { plaidRoutes } from "./routes/plaid.js";
import { runTurn } from "./run.js";
import { initTelemetry } from "./telemetry.js";

const runBody = z.object({
  userId: z.string().min(1),
  message: z.string().min(1),
  taxYear: z.number().int().optional(),
  quarter: z.number().int().min(1).max(4).optional(),
});

export function createApp(deps: AppDeps) {
  const tracing = initTelemetry(deps.env);
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      tracing,
      model: deps.env.ORCHESTRATOR_MODEL,
      plaid: deps.env.PLAID_MODE,
      categorizer: deps.categorizer?.model ?? null,
    }),
  );

  app.post("/threads/:threadId/runs", async (c) => {
    const parsed = runBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const threadId = c.req.param("threadId");
    return streamSSE(c, async (stream) => {
      for await (const ev of runTurn(deps, { ...parsed.data, threadId })) {
        await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
      }
    });
  });

  app.route("/plaid", plaidRoutes(deps));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });
  return app;
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const deps = await buildDeps(env);
  const app = createApp(deps);
  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(
      `taxxy agent listening on :${info.port} (plaid ${env.PLAID_MODE}, categorizer ${deps.categorizer?.model ?? "off"})`,
    );
  });
}
