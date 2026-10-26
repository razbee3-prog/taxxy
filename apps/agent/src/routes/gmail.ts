import { randomBytes } from "node:crypto";
import { getGmailAccount, scoped } from "@taxxy/db";
import { exchangeAuthCode, gmailAuthUrl } from "@taxxy/integrations";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import {
  beginMergeGmail,
  connectGmail,
  extractPriorYear1040,
  syncMergeGmail,
} from "../services/gmail.js";

/**
 * Read-only Gmail. live/fixture: our OAuth flow, `state` binds the callback to the user who
 * started it. merge: Merge Agent Handler's Magic Link; the app polls /status to finish.
 */
export function gmailRoutes(d: AppDeps) {
  const r = new Hono();
  const pending = new Map<string, { userId: string; at: number }>();
  const google = () => {
    if (!d.env.GOOGLE_CLIENT_ID || !d.env.GOOGLE_CLIENT_SECRET)
      throw new Error("Google OAuth client not configured");
    return {
      GOOGLE_CLIENT_ID: d.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: d.env.GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI: d.env.GOOGLE_REDIRECT_URI,
    };
  };

  r.post("/auth-url", async (c) => {
    const p = z
      .object({ userId: z.string().min(1), displayName: z.string().optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    if (d.env.GMAIL_MODE === "merge") {
      const { url } = await beginMergeGmail(d, p.data.userId, p.data.displayName ?? p.data.userId);
      return c.json({ url, mode: "merge" });
    }
    const state = randomBytes(16).toString("hex");
    pending.set(state, { userId: p.data.userId, at: Date.now() });
    if (d.env.GMAIL_MODE === "fixture")
      return c.json({ url: `/gmail/callback?code=fixture&state=${state}`, state });
    return c.json({ url: gmailAuthUrl(google(), state), state });
  });

  r.post("/status", async (c) => {
    const p = z
      .object({ userId: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    if (d.env.GMAIL_MODE === "merge") return c.json(await syncMergeGmail(d, p.data.userId));
    const a = await getGmailAccount(scoped(d.db, p.data.userId));
    return c.json(a ? { connected: true, email: a.email, scope: a.scope } : { connected: false });
  });

  r.get("/callback", async (c) => {
    const { code, state } = c.req.query();
    const p = state ? pending.get(state) : undefined;
    if (!code || !p || Date.now() - p.at > 15 * 60_000)
      return c.json({ error: "invalid or expired state" }, 400);
    pending.delete(state as string);
    const tokens =
      d.env.GMAIL_MODE === "fixture"
        ? { refresh_token: "fixture", scope: "https://www.googleapis.com/auth/gmail.readonly" }
        : await exchangeAuthCode(google(), code);
    const acct = await connectGmail(d, p.userId, tokens);
    return c.json({ connected: true, email: acct.email, scope: acct.scope });
  });

  r.post("/upload-1040", async (c) => {
    const p = z
      .object({
        userId: z.string().min(1),
        filename: z.string(),
        mime: z.string(),
        base64: z.string(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    const stored = await d.files.put(
      p.data.userId,
      Buffer.from(p.data.base64, "base64"),
      p.data.mime,
      p.data.filename,
    );
    return c.json(await extractPriorYear1040(d, p.data.userId, { fileRef: stored.fileRef }));
  });

  return r;
}
