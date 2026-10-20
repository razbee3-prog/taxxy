import { type Row, type ScopedDb, toRecordId } from "../tenancy.js";
import type { TransactionRow } from "./transactions.js";

export type CategorizationSource = "rule" | "llm" | "user";
export type CategorizationStatus = "auto" | "uncertain" | "accepted";

export interface CategorizationRow extends Row {
  transaction: string;
  label: string;
  is_business: boolean;
  confidence: number;
  source: CategorizationSource;
  status: CategorizationStatus;
  rationale: string | null;
  model: string | null;
  rule_id: string | null;
  superseded_by: string | null;
  needs_receipt: boolean;
}

export interface CategorizationInput {
  transaction: string;
  label: string;
  is_business: boolean;
  confidence: number;
  source: CategorizationSource;
  status: CategorizationStatus;
  rationale?: string | null;
  model?: string | null;
  rule_id?: string | null;
  needs_receipt?: boolean;
}

/** Append-only: the new row becomes current and every earlier current row for the transaction points at it. */
export async function recordCategorization(
  s: ScopedDb,
  c: CategorizationInput,
): Promise<CategorizationRow> {
  const txn = toRecordId(c.transaction);
  const owned = await s.get<TransactionRow>(txn);
  if (!owned) throw new Error(`transaction ${c.transaction} not found for user`);
  const row = await s.create<CategorizationRow>("categorization", { ...c, transaction: txn });
  await s.query(
    "UPDATE categorization SET superseded_by = $new WHERE user = $user AND transaction = $txn AND superseded_by = NONE AND id != $new",
    { new: toRecordId(row.id), txn },
  );
  return row;
}

export async function recordCategorizations(
  s: ScopedDb,
  cs: CategorizationInput[],
): Promise<CategorizationRow[]> {
  const out: CategorizationRow[] = [];
  for (const c of cs) out.push(await recordCategorization(s, c));
  return out;
}

export async function currentCategorization(
  s: ScopedDb,
  transactionId: string,
): Promise<CategorizationRow | null> {
  const rows = await s.select<CategorizationRow>(
    "categorization",
    "transaction = $txn AND superseded_by = NONE",
    { txn: toRecordId(transactionId) },
    "ORDER BY created_at DESC LIMIT 1",
  );
  return rows[0] ?? null;
}

export interface ReviewItem {
  categorization: CategorizationRow;
  transaction: TransactionRow;
}

/** Current rows with status uncertain (confidence below threshold), newest transactions first. */
export async function reviewQueue(s: ScopedDb, limit = 10): Promise<ReviewItem[]> {
  const rows = await s.query<CategorizationRow & { transaction: TransactionRow }>(
    `SELECT * FROM categorization WHERE user = $user AND status = 'uncertain' AND superseded_by = NONE AND transaction.removed = false ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(200, limit))} FETCH transaction`,
  );
  return rows.map((r) => ({
    categorization: { ...r, transaction: r.transaction.id },
    transaction: r.transaction,
  }));
}

export async function listCurrentCategorizations(
  s: ScopedDb,
  opts: { statuses?: CategorizationStatus[]; limit?: number } = {},
): Promise<Array<CategorizationRow & { txn: TransactionRow }>> {
  const statuses = opts.statuses ?? ["auto", "uncertain", "accepted"];
  const rows = await s.query<CategorizationRow & { transaction: TransactionRow }>(
    `SELECT * FROM categorization WHERE user = $user AND superseded_by = NONE AND status IN $statuses AND transaction.removed = false ORDER BY created_at DESC LIMIT ${opts.limit ?? 2000} FETCH transaction`,
    { statuses },
  );
  return rows.map((r) => ({ ...r, transaction: r.transaction.id, txn: r.transaction }));
}

/** Uncategorized = transactions with no current categorization row. */
export async function uncategorizedTransactions(
  s: ScopedDb,
  limit = 500,
): Promise<TransactionRow[]> {
  return s.query<TransactionRow>(
    `SELECT * FROM transaction WHERE user = $user AND removed = false AND id NOTINSIDE (SELECT VALUE transaction FROM categorization WHERE user = $user AND superseded_by = NONE) ORDER BY date DESC LIMIT ${limit}`,
  );
}

/** The 20 most recent user labels, as few-shot material for the categorizer. */
export async function recentUserLabels(s: ScopedDb, limit = 20) {
  const rows = await s.query<CategorizationRow & { transaction: TransactionRow }>(
    `SELECT * FROM categorization WHERE user = $user AND source = 'user' AND superseded_by = NONE ORDER BY created_at DESC LIMIT ${limit} FETCH transaction`,
  );
  return rows.map((r) => ({
    merchant_key: r.transaction.merchant_key,
    description: r.transaction.description,
    amount: r.transaction.amount,
    label: r.label,
    is_business: r.is_business,
  }));
}
