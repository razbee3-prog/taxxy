import { type Row, type ScopedDb, toRecordId } from "../tenancy.js";

export interface TransactionRow extends Row {
  bank_account: string;
  plaid_txn_id: string;
  date: string;
  amount: number;
  description: string;
  merchant_key: string | null;
  plaid_pfc: string | null;
  counterparties: string[];
  pending: boolean;
  removed: boolean;
}

export interface TransactionInput {
  plaid_txn_id: string;
  plaid_account_id: string;
  date: string;
  amount: number;
  description: string;
  merchant_key: string | null;
  plaid_pfc: string | null;
  counterparties: string[];
  pending: boolean;
}

export const txnRecordId = (plaidTxnId: string) => `transaction:${plaidTxnId}`;

/** Inserts new rows, merges changed ones. Returns ids of rows that were new or changed (they need (re)categorization). */
export async function upsertTransactions(
  s: ScopedDb,
  txns: TransactionInput[],
): Promise<{ created: string[]; updated: string[] }> {
  const created: string[] = [];
  const updated: string[] = [];
  if (!txns.length) return { created, updated };
  const existing = await s.query<{ plaid_txn_id: string }>(
    "SELECT plaid_txn_id FROM transaction WHERE user = $user AND plaid_txn_id IN $ids",
    { ids: txns.map((t) => t.plaid_txn_id) },
  );
  const have = new Set(existing.map((e) => e.plaid_txn_id));
  for (const t of txns) {
    const data = {
      plaid_txn_id: t.plaid_txn_id,
      date: t.date,
      amount: t.amount,
      description: t.description,
      merchant_key: t.merchant_key,
      plaid_pfc: t.plaid_pfc,
      counterparties: t.counterparties,
      pending: t.pending,
      bank_account: toRecordId(`bank_account:${t.plaid_account_id}`),
    };
    const id = txnRecordId(t.plaid_txn_id);
    if (have.has(t.plaid_txn_id)) {
      await s.update(id, { ...data, removed: false });
      updated.push(id);
    } else {
      await s.createWithId(id, data);
      created.push(id);
    }
  }
  return { created, updated };
}

export async function markRemoved(s: ScopedDb, plaidTxnIds: string[]): Promise<string[]> {
  if (!plaidTxnIds.length) return [];
  const rows = await s.query<{ id: string }>(
    "UPDATE transaction SET removed = true WHERE user = $user AND plaid_txn_id IN $ids RETURN id",
    { ids: plaidTxnIds },
  );
  return rows.map((r) => r.id);
}

export async function listTransactions(
  s: ScopedDb,
  opts: { from?: string; to?: string; includePending?: boolean; limit?: number } = {},
): Promise<TransactionRow[]> {
  const where = ["removed = false"];
  const b: Record<string, unknown> = {};
  if (opts.from) {
    where.push("date >= $from");
    b.from = opts.from;
  }
  if (opts.to) {
    where.push("date <= $to");
    b.to = opts.to;
  }
  if (!opts.includePending) where.push("pending = false");
  return s.select<TransactionRow>(
    "transaction",
    where.join(" AND "),
    b,
    `ORDER BY date DESC LIMIT ${opts.limit ?? 1000}`,
  );
}

export async function getTransactions(s: ScopedDb, ids: string[]): Promise<TransactionRow[]> {
  if (!ids.length) return [];
  return s.query<TransactionRow>("SELECT * FROM transaction WHERE user = $user AND id IN $ids", {
    ids: ids.map((i) => toRecordId(i)),
  });
}
