import type { RecordId, Surreal } from "surrealdb";
import type { Row, ScopedDb } from "../tenancy.js";
import type { Vault } from "../vault.js";

export interface BankItemPublic extends Row {
  plaid_item_id: string;
  cursor: string | null;
  institution: string | null;
  status: "active" | "login_required" | "removed";
}

type BankItemRow = BankItemPublic & { access_token_enc: string };

function strip(row: BankItemRow): BankItemPublic {
  const { access_token_enc: _secret, ...pub } = row;
  return pub;
}

/** Access tokens are sealed with the vault and never leave this module except via `withAccessToken`. */
export async function createBankItem(
  s: ScopedDb,
  vault: Vault,
  item: { plaid_item_id: string; access_token: string; institution?: string },
): Promise<BankItemPublic> {
  const row = await s.createWithId<BankItemRow>(`bank_item:${item.plaid_item_id}`, {
    plaid_item_id: item.plaid_item_id,
    access_token_enc: vault.seal(item.access_token, s.userId),
    institution: item.institution,
  });
  return strip(row);
}

export async function listBankItems(s: ScopedDb): Promise<BankItemPublic[]> {
  return (await s.select<BankItemRow>("bank_item", "status != 'removed'")).map(strip);
}

export async function withAccessToken<T>(
  s: ScopedDb,
  vault: Vault,
  itemId: string,
  fn: (accessToken: string, item: BankItemPublic) => Promise<T>,
): Promise<T> {
  const row = await s.get<BankItemRow>(itemId);
  if (!row) throw new Error(`bank_item ${itemId} not found for user`);
  return fn(vault.open(row.access_token_enc, s.userId), strip(row));
}

export async function setBankItemCursor(
  s: ScopedDb,
  itemId: string,
  cursor: string,
): Promise<void> {
  await s.update(itemId, { cursor });
}

export async function setBankItemStatus(
  s: ScopedDb,
  itemId: string,
  status: BankItemPublic["status"],
): Promise<void> {
  await s.update(itemId, { status });
}

/** Webhooks arrive with only a Plaid item id: resolve the owner, then everything else is scoped. */
export async function ownerOfPlaidItem(db: Surreal, plaidItemId: string): Promise<string | null> {
  const [rows] = await db.query<[{ user: RecordId }[]]>(
    "SELECT user FROM bank_item WHERE plaid_item_id = $id LIMIT 1",
    { id: plaidItemId },
  );
  const u = rows?.[0]?.user;
  return u ? String(u.id) : null;
}
