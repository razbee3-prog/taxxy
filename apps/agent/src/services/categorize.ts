import {
  getTaxProfile,
  getTransactions,
  listBankAccounts,
  listMerchantRules,
  listPayers,
  recentUserLabels,
  recordCategorizations,
  scoped,
  type TransactionRow,
} from "@taxxy/db";
import {
  type CategorizationContext,
  categorizeTransactions,
  type ModelLabel,
  type NormalizedTransaction,
} from "@taxxy/integrations";
import type { AppDeps } from "../deps.js";

export async function buildContext(d: AppDeps, userId: string): Promise<CategorizationContext> {
  const s = scoped(d.db, userId);
  const [profile, accounts, payers, rules, labels] = await Promise.all([
    getTaxProfile(s),
    listBankAccounts(s),
    listPayers(s),
    listMerchantRules(s),
    recentUserLabels(s),
  ]);
  return {
    businessDescription: profile?.business_description ?? null,
    mostlyBusinessAccounts: new Set(
      accounts.filter((a) => a.mostly_business).map((a) => a.plaid_account_id),
    ),
    linkedAccountIds: new Set(accounts.map((a) => a.plaid_account_id)),
    payers: payers.map((p) => ({ counterparty: p.counterparty, is_income: p.is_income })),
    merchantRules: rules.map((r) => ({
      merchant_key: r.merchant_key,
      label: r.label as ModelLabel,
      is_business: r.is_business,
      condition: r.condition,
    })),
    recentUserLabels: labels.map((l) => ({ ...l, label: l.label as ModelLabel })),
  };
}

function toNormalized(t: TransactionRow): NormalizedTransaction {
  return {
    plaid_txn_id: t.plaid_txn_id,
    plaid_account_id: t.bank_account.replace(/^bank_account:/, ""),
    date: t.date,
    amount: t.amount,
    description: t.description,
    normalized_description: t.description,
    merchant_key: t.merchant_key,
    plaid_pfc: t.plaid_pfc,
    counterparties: t.counterparties,
    pending: t.pending,
    pending_transaction_id: null,
  };
}

export interface CategorizeSummary {
  total: number;
  auto: number;
  uncertain: number;
  needsReceipt: number;
}

/** Runs rules → categorizer → gate for the given transaction record ids and appends the decisions. */
export async function categorizeTransactionIds(
  d: AppDeps,
  userId: string,
  ids: string[],
): Promise<CategorizeSummary> {
  const s = scoped(d.db, userId);
  const rows = await getTransactions(s, ids);
  if (!rows.length) return { total: 0, auto: 0, uncertain: 0, needsReceipt: 0 };
  const ctx = await buildContext(d, userId);
  const decisions = await categorizeTransactions(rows.map(toNormalized), ctx, d.categorizer, {
    threshold: d.env.CATEGORIZER_THRESHOLD,
  });
  await recordCategorizations(
    s,
    decisions.map((x) => ({
      transaction: `transaction:${x.plaid_txn_id}`,
      label: x.label,
      is_business: x.is_business,
      confidence: x.confidence,
      source: x.source,
      status: x.status,
      rationale: x.rationale,
      model: x.model ?? null,
      rule_id: x.rule_id ?? null,
      needs_receipt: x.needs_receipt,
    })),
  );
  return {
    total: decisions.length,
    auto: decisions.filter((x) => x.status === "auto").length,
    uncertain: decisions.filter((x) => x.status === "uncertain").length,
    needsReceipt: decisions.filter((x) => x.needs_receipt).length,
  };
}
