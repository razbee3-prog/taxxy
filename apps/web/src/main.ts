import { randomBytes } from "node:crypto";
import { relative } from "node:path";
import { serve } from "@hono/node-server";
import { connectSurreal, dbConfigFromEnv, migrate } from "@taxxy/db";
import { LocalAuthProvider } from "./auth.js";
import { createWebApp } from "./server.js";

const cfg = dbConfigFromEnv();
const db = await connectSurreal(cfg.app);
await migrate(db);
const sessionSecret = process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET not set: sessions reset on restart");
const publicDir = relative(process.cwd(), new URL("../public", import.meta.url).pathname) || ".";
const app = createWebApp({
  db,
  auth: new LocalAuthProvider(db),
  sessionSecret,
  agentUrl: process.env.AGENT_URL ?? "http://127.0.0.1:8787",
  publicDir,
});
const port = Number(process.env.WEB_PORT ?? 3000);
serve({ fetch: app.fetch, port }, () =>
  console.log(
    `taxxy web on http://localhost:${port} → agent ${process.env.AGENT_URL ?? "http://127.0.0.1:8787"}`,
  ),
);
