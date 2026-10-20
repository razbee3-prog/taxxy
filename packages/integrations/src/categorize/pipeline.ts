import type { NormalizedTransaction } from "../plaid/types.js";
import { DEFAULT_THRESHOLD, gate, needsReceipt } from "./gate.js";
import { applyRules } from "./rules.js";
import type { CategorizationContext, Categorizer, CategorizerItem, Decision } from "./types.js";

export interface PipelineOptions {
  threshold?: number;
  /** plaid_txn_ids that already have evidence (a matched receipt). */
  evidence?: Set<string>;
}

/** Rules → LLM → gate. Returns one Decision per transaction, in input order. */
export async function categorizeTransactions(
  txns: NormalizedTransaction[],
  ctx: CategorizationContext,
  categorizer: Categorizer | null,
  opts: PipelineOptions = {},
): Promise<Decision[]> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const evidence = opts.evidence ?? new Set<string>();
  const decisions = new Map<string, Decision>();
  const forModel: NormalizedTransaction[] = [];

  for (const t of txns) {
    const hit = applyRules(t, ctx);
    if (hit) {
      decisions.set(t.plaid_txn_id, finalize(t, { ...hit, source: "rule" }, threshold, evidence));
    } else {
      forModel.push(t);
    }
  }

  if (forModel.length && categorizer) {
    const items: CategorizerItem[] = forModel.map((t, i) => ({
      ref: `t${i}`,
      date: t.date,
      amount: t.amount,
      description: t.normalized_description || t.description,
      merchant_key: t.merchant_key,
      plaid_pfc: t.plaid_pfc,
      counterparties: t.counterparties,
      account_mostly_business: ctx.mostlyBusinessAccounts.has(t.plaid_account_id),
    }));
    const out = await categorizer.categorize(items, ctx);
    const byRef = new Map(out.map((o) => [o.ref, o]));
    forModel.forEach((t, i) => {
      const o = byRef.get(`t${i}`);
      decisions.set(
        t.plaid_txn_id,
        finalize(
          t,
          o
            ? {
                label: o.label,
                is_business: o.isBusiness,
                confidence: clamp(o.confidence),
                rationale: o.rationale,
                source: "llm",
                model: categorizer.model,
              }
            : {
                label: "personal",
                is_business: false,
                confidence: 0,
                rationale: "no model output",
                source: "llm",
                model: categorizer.model,
              },
          threshold,
          evidence,
        ),
      );
    });
  }
  for (const t of forModel) {
    if (!decisions.has(t.plaid_txn_id)) {
      decisions.set(
        t.plaid_txn_id,
        finalize(
          t,
          {
            label: "personal",
            is_business: false,
            confidence: 0,
            rationale: "no categorizer configured",
            source: "llm",
          },
          threshold,
          evidence,
        ),
      );
    }
  }
  return txns.map((t) => decisions.get(t.plaid_txn_id) as Decision);
}

function clamp(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function finalize(
  t: NormalizedTransaction,
  d: Omit<Decision, "plaid_txn_id" | "status" | "needs_receipt">,
  threshold: number,
  evidence: Set<string>,
): Decision {
  const status = gate(d.confidence, threshold);
  return {
    plaid_txn_id: t.plaid_txn_id,
    ...d,
    status,
    needs_receipt: needsReceipt(d, t.amount, evidence.has(t.plaid_txn_id)),
  };
}
