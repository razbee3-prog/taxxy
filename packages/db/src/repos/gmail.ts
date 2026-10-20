import { recordAudit } from "../audit.js";
import { type Row, type ScopedDb, toRecordId } from "../tenancy.js";
import type { Vault } from "../vault.js";

export interface GmailAccountPublic extends Row {
  email: string;
  scope: string;
  status: "active" | "revoked";
}
type GmailRow = GmailAccountPublic & { refresh_token_enc: string };

const strip = ({ refresh_token_enc: _s, ...pub }: GmailRow): GmailAccountPublic => pub;

export async function connectGmailAccount(
  s: ScopedDb,
  vault: Vault,
  a: { email: string; refresh_token: string; scope: string },
): Promise<GmailAccountPublic> {
  const existing = (await s.select<GmailRow>("gmail_account", "true", {}, "LIMIT 1"))[0];
  const data = {
    email: a.email,
    scope: a.scope,
    status: "active",
    refresh_token_enc: vault.seal(a.refresh_token, s.userId),
  };
  const row = existing
    ? await s.update<GmailRow>(existing.id, data)
    : await s.create<GmailRow>("gmail_account", data);
  await recordAudit(s, {
    actor: "user",
    action: "gmail.connect",
    target: row.id,
    after: { email: a.email, scope: a.scope },
  });
  return strip(row);
}

export async function getGmailAccount(s: ScopedDb): Promise<GmailAccountPublic | null> {
  const row = (await s.select<GmailRow>("gmail_account", "status = 'active'", {}, "LIMIT 1"))[0];
  return row ? strip(row) : null;
}

export async function withGmailRefreshToken<T>(
  s: ScopedDb,
  vault: Vault,
  fn: (token: string, acct: GmailAccountPublic) => Promise<T>,
): Promise<T | null> {
  const row = (await s.select<GmailRow>("gmail_account", "status = 'active'", {}, "LIMIT 1"))[0];
  if (!row) return null;
  return fn(vault.open(row.refresh_token_enc, s.userId), strip(row));
}

export interface ReceiptRow extends Row {
  gmail_message_id: string;
  attachment_id: string | null;
  vendor: string | null;
  total: number | null;
  date: string | null;
  file_ref: string | null;
  transaction: string | null;
  match_score: number | null;
}

export async function upsertReceipt(
  s: ScopedDb,
  r: Omit<ReceiptRow, keyof Row>,
): Promise<ReceiptRow> {
  const existing = (
    await s.select<ReceiptRow>("receipt", "gmail_message_id = $m AND attachment_id = $a", {
      m: r.gmail_message_id,
      a: r.attachment_id,
    })
  )[0];
  const data = { ...r, transaction: r.transaction ? toRecordId(r.transaction) : null };
  return existing ? s.update<ReceiptRow>(existing.id, data) : s.create<ReceiptRow>("receipt", data);
}

export async function listReceipts(
  s: ScopedDb,
  opts: { matched?: boolean } = {},
): Promise<ReceiptRow[]> {
  const where =
    opts.matched === undefined
      ? "true"
      : opts.matched
        ? "transaction != NONE"
        : "transaction = NONE";
  return s.select<ReceiptRow>("receipt", where, {}, "ORDER BY date DESC");
}
