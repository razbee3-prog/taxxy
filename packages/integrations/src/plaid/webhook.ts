import { createHash } from "node:crypto";
import { z } from "zod";

export const plaidWebhookSchema = z.object({
  webhook_type: z.string(),
  webhook_code: z.string(),
  item_id: z.string(),
  error: z.object({ error_code: z.string().optional() }).nullable().optional(),
});
export type PlaidWebhook = z.infer<typeof plaidWebhookSchema>;

/** Codes that mean "run /transactions/sync for this item". */
export const SYNC_CODES = new Set([
  "SYNC_UPDATES_AVAILABLE",
  "INITIAL_UPDATE",
  "HISTORICAL_UPDATE",
  "DEFAULT_UPDATE",
]);

export function bodySha256(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

/**
 * Plaid signs webhooks with an ES256 JWT in `Plaid-Verification` whose `request_body_sha256`
 * claim must match the raw body. The JWK is fetched by `kid` through `getKey`.
 */
export async function verifyPlaidWebhook(
  jwt: string | undefined,
  rawBody: string,
  getKey: (kid: string) => Promise<JsonWebKey>,
): Promise<boolean> {
  if (!jwt) return false;
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return false;
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== "ES256" || !header.kid) return false;
  const jwk = await getKey(header.kid);
  const { webcrypto } = await import("node:crypto");
  const key = await webcrypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(s, "base64url"),
    Buffer.from(`${h}.${p}`),
  );
  if (!ok) return false;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as {
    iat?: number;
    request_body_sha256?: string;
  };
  if (!claims.iat || Date.now() / 1000 - claims.iat > 300) return false;
  return claims.request_body_sha256 === bodySha256(rawBody);
}
