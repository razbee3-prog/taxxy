import { serveStatic } from "@hono/node-server/serve-static";
import { getGmailAccount, listBankAccounts, listBankItems, listEstimates, scoped } from "@taxxy/db";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Surreal } from "surrealdb";
import { z } from "zod";
import { type AuthProvider, type Session, signSession, verifySession } from "./auth.js";

export interface WebDeps {
  db: Surreal;
  auth: AuthProvider;
  sessionSecret: string;
  agentUrl: string;
  publicDir?: string;
  fetch?: typeof fetch;
}

const COOKIE = "taxxy_session";
const credentials = z.object({ email: z.string().email(), password: z.string().min(1) });

/**
 * Web surface. The browser never talks to the agent directly: every agent call is proxied here with
 * `userId` taken from the verified session cookie (spec: userId comes from the session, never the model).
 */
export function createWebApp(d: WebDeps) {
  const app = new Hono<{ Variables: { session: Session } }>();
  const f = d.fetch ?? fetch;
  const agent = (path: string, body: unknown) =>
    f(`${d.agentUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const issue = (c: Context, s: { userId: string; email: string }) => {
    setCookie(c, COOKIE, signSession(d.sessionSecret, s), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
    });
  };

  app.post("/auth/signup", async (c) => {
    const p = credentials.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "email and password required" }, 400);
    try {
      const s = await d.auth.signUp(p.data.email, p.data.password);
      issue(c, s);
      return c.json({ userId: s.userId, email: s.email });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "sign-up failed";
      return c.json(
        {
          error: /unique|already exists|index/i.test(msg)
            ? "an account with that email already exists"
            : msg,
        },
        400,
      );
    }
  });

  app.post("/auth/login", async (c) => {
    const p = credentials.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "email and password required" }, 400);
    const s = await d.auth.signIn(p.data.email, p.data.password);
    if (!s) return c.json({ error: "invalid email or password" }, 401);
    issue(c, s);
    return c.json({ userId: s.userId, email: s.email });
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.use("/api/*", async (c, next) => {
    const s = verifySession(d.sessionSecret, getCookie(c, COOKIE));
    if (!s) return c.json({ error: "not signed in" }, 401);
    c.set("session", s);
    await next();
  });

  app.get("/api/me", async (c) => {
    const s = c.get("session");
    const sc = scoped(d.db, s.userId);
    const [items, accounts, gmail, estimates] = await Promise.all([
      listBankItems(sc),
      listBankAccounts(sc),
      getGmailAccount(sc),
      listEstimates(sc),
    ]);
    return c.json({
      userId: s.userId,
      email: s.email,
      banks: items.map((i) => ({
        itemId: i.id,
        institution: i.institution,
        status: i.status,
        accounts: accounts
          .filter((a) => a.bank_item === i.id)
          .map((a) => ({
            id: a.id,
            name: a.name,
            mask: a.mask,
            mostlyBusiness: a.mostly_business,
          })),
      })),
      gmail: gmail ? { email: gmail.email, scope: gmail.scope } : null,
      estimates: estimates.map((e) => ({
        id: e.id,
        taxYear: e.tax_year,
        quarter: e.quarter,
        status: e.status,
        installmentDue: (e.result as { installmentDue: number }).installmentDue,
        dueDate: (e.result as { dueDate: string }).dueDate,
      })),
    });
  });

  app.post("/api/plaid/link-token", async (c) => {
    const s = c.get("session");
    const r = await agent("/plaid/link-token", { userId: s.userId });
    return c.json(await r.json(), r.status as 200);
  });

  app.post("/api/plaid/exchange", async (c) => {
    const s = c.get("session");
    const p = z
      .object({ publicToken: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "publicToken required" }, 400);
    const r = await agent("/plaid/exchange", {
      userId: s.userId,
      publicToken: p.data.publicToken,
      email: s.email,
    });
    return c.json(await r.json(), r.status as 200);
  });

  app.post("/api/plaid/sync", async (c) => {
    const s = c.get("session");
    const r = await agent("/plaid/sync", { userId: s.userId });
    return c.json(await r.json(), r.status as 200);
  });

  app.post("/api/gmail/auth-url", async (c) => {
    const s = c.get("session");
    const r = await agent("/gmail/auth-url", { userId: s.userId });
    return c.json(await r.json(), r.status as 200);
  });

  /** Google redirects here; forwarded to the agent (which holds the OAuth client), then back to the app. */
  app.get("/gmail/callback", async (c) => {
    const r = await f(`${d.agentUrl}/gmail/callback?${new URL(c.req.url).searchParams.toString()}`);
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    return c.redirect(
      r.ok
        ? "/?gmail=connected"
        : `/?gmail=error&reason=${encodeURIComponent(body.error ?? r.statusText)}`,
    );
  });

  /** Chat: forwards one turn and streams the agent's SSE back unchanged. */
  app.post("/api/chat", async (c) => {
    const s = c.get("session");
    const p = z
      .object({
        message: z.string().min(1).max(4000),
        threadId: z.string().optional(),
        taxYear: z.number().int().optional(),
        quarter: z.number().int().min(1).max(4).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "message required" }, 400);
    const now = new Date();
    const taxYear = p.data.taxYear ?? now.getUTCFullYear();
    const quarter = p.data.quarter ?? Math.min(4, Math.floor(now.getUTCMonth() / 3) + 1);
    const threadId = p.data.threadId ?? `${s.userId}:${taxYear}:${quarter}`;
    const r = await agent(`/threads/${encodeURIComponent(threadId)}/runs`, {
      userId: s.userId,
      message: p.data.message,
      taxYear,
      quarter,
    });
    if (!r.ok || !r.body) return c.json({ error: `agent returned ${r.status}` }, 502);
    return new Response(r.body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-thread-id": threadId,
      },
    });
  });

  if (d.publicDir) {
    app.use("/*", serveStatic({ root: d.publicDir }));
    app.get("/*", serveStatic({ root: d.publicDir, path: "index.html" }));
  }
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });
  return app;
}
