import type { AccountBase, RemovedTransaction, Transaction } from "plaid";
import type { NormalizedTransaction, PlaidAccountSummary } from "./types.js";

const NOISE = [
  /\b(?:ref|inv|invoice|order|auth|trans|txn|id)[#:\s]*[a-z0-9-]{4,}\b/gi, // reference labels
  /\b(?:x{2,}|\*{2,})\d{2,}\b/gi, // masked card numbers
  /\b\d{2}\/\d{2}(?:\/\d{2,4})?\b/g, // dates
  /\b\d{6,}\b/g, // long reference / invoice numbers
  /[#*]+/g,
  /\bpos\b|\bdebit\b|\bpurchase\b|\bcard\b|\bach\b|\belectronic\b|\bpayment\b/gi,
];

/** Strips card suffixes, dates and reference numbers so the same merchant collapses to one key. */
export function normalizeDescription(raw: string): string {
  let s = raw.normalize("NFKC");
  for (const re of NOISE) s = s.replace(re, " ");
  return s
    .replace(/[^\p{L}\p{N} .&'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function merchantKey(
  txn: Pick<Transaction, "merchant_name" | "name" | "counterparties">,
): string | null {
  const merchantCp = txn.counterparties?.find((c) => c.type === "merchant" && c.name);
  const base = txn.merchant_name ?? merchantCp?.name ?? normalizeDescription(txn.name);
  if (!base) return null;
  const key = base
    .toLowerCase()
    .replace(/\b(?:inc|llc|ltd|corp|co)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 3)
    .join("_");
  return key || null;
}

export function normalizeTransaction(t: Transaction): NormalizedTransaction {
  return {
    plaid_txn_id: t.transaction_id,
    plaid_account_id: t.account_id,
    date: t.authorized_date ?? t.date,
    amount: t.amount,
    description: t.name,
    normalized_description: normalizeDescription(t.name),
    merchant_key: merchantKey(t),
    plaid_pfc: t.personal_finance_category?.detailed ?? null,
    counterparties: (t.counterparties ?? [])
      .map((c) => c.name)
      .filter((n): n is string => Boolean(n)),
    pending: t.pending,
    pending_transaction_id: t.pending_transaction_id ?? null,
  };
}

export function normalizeAccount(a: AccountBase): PlaidAccountSummary {
  return {
    plaid_account_id: a.account_id,
    name: a.name,
    mask: a.mask ? a.mask.slice(-4) : null,
    type: a.type,
    subtype: a.subtype ?? null,
  };
}

export function removedIds(r: RemovedTransaction[]): string[] {
  return r.map((x) => x.transaction_id).filter((x): x is string => Boolean(x));
}
