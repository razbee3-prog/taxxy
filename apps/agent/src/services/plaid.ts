import {
  createBankItem,
  ensureUser,
  listBankItems,
  markRemoved,
  ownerOfPlaidItem,
  scoped,
  setBankItemCursor,
  setBankItemStatus,
  upsertBankAccounts,
  upsertTransactions,
  withAccessToken,
} from "@taxxy/db";
import { PlaidItemLoginRequired, type PlaidWebhook, SYNC_CODES } from "@taxxy/integrations";
import type { AppDeps } from "../deps.js";
import { type CategorizeSummary, categorizeTransactionIds } from "./categorize.js";

export async function createLinkToken(d: AppDeps, userId: string) {
  return d.plaid.createLinkToken(userId, d.env.PLAID_WEBHOOK_URL);
}

/** Link callback: exchange, store the sealed token, mirror accounts (last-4 only), then do the initial 24-month pull. */
export async function exchangePublicToken(
  d: AppDeps,
  userId: string,
  publicToken: string,
  email?: string,
) {
  if (email) await ensureUser(d.db, userId, email);
  const s = scoped(d.db, userId);
  const linked = await d.plaid.exchangePublicToken(publicToken);
  const item = await createBankItem(s, d.vault, {
    plaid_item_id: linked.itemId,
    access_token: linked.accessToken,
    institution: linked.institution ?? undefined,
  });
  const accounts = await upsertBankAccounts(s, item.id, linked.accounts);
  return {
    itemId: item.id,
    institution: item.institution,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, mask: a.mask, type: a.type })),
  };
}

export interface SyncResult {
  itemId: string;
  added: number;
  modified: number;
  removed: number;
  cursor: string | null;
  categorized: CategorizeSummary;
  status: "ok" | "login_required";
}

export async function syncItem(d: AppDeps, userId: string, itemId: string): Promise<SyncResult> {
  const s = scoped(d.db, userId);
  try {
    return await withAccessToken(s, d.vault, itemId, async (token, item) => {
      let cursor = item.cursor;
      const changed = new Set<string>();
      let added = 0;
      let modified = 0;
      let removed = 0;
      for (let i = 0; i < 200; i++) {
        const page = await d.plaid.syncTransactions(token, cursor);
        const up = await upsertTransactions(s, [...page.added, ...page.modified]);
        for (const id of [...up.created, ...up.updated]) changed.add(id);
        await markRemoved(s, page.removed);
        added += page.added.length;
        modified += page.modified.length;
        removed += page.removed.length;
        cursor = page.nextCursor;
        await setBankItemCursor(s, itemId, cursor);
        if (!page.hasMore) break;
      }
      const categorized = await categorizeTransactionIds(d, userId, [...changed]);
      return { itemId, added, modified, removed, cursor, categorized, status: "ok" };
    });
  } catch (err) {
    if (err instanceof PlaidItemLoginRequired) {
      await setBankItemStatus(s, itemId, "login_required");
      return {
        itemId,
        added: 0,
        modified: 0,
        removed: 0,
        cursor: null,
        categorized: { total: 0, auto: 0, uncertain: 0, needsReceipt: 0 },
        status: "login_required",
      };
    }
    throw err;
  }
}

export async function syncAll(d: AppDeps, userId: string): Promise<SyncResult[]> {
  const items = await listBankItems(scoped(d.db, userId));
  const out: SyncResult[] = [];
  for (const it of items) if (it.status === "active") out.push(await syncItem(d, userId, it.id));
  return out;
}

/** Webhook body → owner lookup → scoped sync. Returns null when the item is unknown. */
export async function handleWebhook(
  d: AppDeps,
  hook: PlaidWebhook,
): Promise<SyncResult | { ignored: string } | null> {
  const userId = await ownerOfPlaidItem(d.db, hook.item_id);
  if (!userId) return null;
  const itemId = `bank_item:${hook.item_id}`;
  if (hook.webhook_type === "TRANSACTIONS" && SYNC_CODES.has(hook.webhook_code))
    return syncItem(d, userId, itemId);
  if (hook.webhook_type === "ITEM" && hook.error?.error_code === "ITEM_LOGIN_REQUIRED") {
    await setBankItemStatus(scoped(d.db, userId), itemId, "login_required");
    return { ignored: "marked login_required" };
  }
  return { ignored: `${hook.webhook_type}/${hook.webhook_code}` };
}
