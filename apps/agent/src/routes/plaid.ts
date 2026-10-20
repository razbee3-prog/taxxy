import { bodySha256, plaidWebhookSchema, verifyPlaidWebhook } from "@taxxy/integrations";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import {
  createLinkToken,
  exchangePublicToken,
  handleWebhook,
  syncAll,
  syncItem,
} from "../services/plaid.js";

const userBody = z.object({ userId: z.string().min(1), email: z.string().email().optional() });

/** HTTP surface for Link (web app) and Plaid webhooks. `userId` here comes from the web session, not the model. */
export function plaidRoutes(d: AppDeps) {
  const r = new Hono();

  r.post("/link-token", async (c) => {
    const p = userBody.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    return c.json(await createLinkToken(d, p.data.userId));
  });

  r.post("/exchange", async (c) => {
    const p = userBody
      .extend({ publicToken: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    const linked = await exchangePublicToken(d, p.data.userId, p.data.publicToken, p.data.email);
    const sync = await syncItem(d, p.data.userId, linked.itemId);
    return c.json({ ...linked, sync });
  });

  r.post("/sync", async (c) => {
    const p = userBody
      .extend({ itemId: z.string().optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    return c.json(
      p.data.itemId
        ? [await syncItem(d, p.data.userId, p.data.itemId)]
        : await syncAll(d, p.data.userId),
    );
  });

  r.post("/webhook", async (c) => {
    const raw = await c.req.text();
    if (d.env.PLAID_WEBHOOK_VERIFY) {
      const api = (
        d.plaid as {
          api?: {
            webhookVerificationKeyGet: (a: {
              key_id: string;
            }) => Promise<{ data: { key: JsonWebKey } }>;
          };
        }
      ).api;
      const ok =
        api &&
        (await verifyPlaidWebhook(
          c.req.header("plaid-verification"),
          raw,
          async (kid) => (await api.webhookVerificationKeyGet({ key_id: kid })).data.key,
        ));
      if (!ok)
        return c.json({ error: "webhook verification failed", body_sha256: bodySha256(raw) }, 401);
    }
    const p = plaidWebhookSchema.safeParse(JSON.parse(raw || "{}"));
    if (!p.success) return c.json({ error: p.error.flatten() }, 400);
    const res = await handleWebhook(d, p.data);
    if (res === null) return c.json({ ignored: "unknown item" }, 202);
    return c.json(res);
  });

  return r;
}
