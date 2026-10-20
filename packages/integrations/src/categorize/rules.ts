import type { NormalizedTransaction } from "../plaid/types.js";
import type { CategorizationContext, Decision } from "./types.js";

type RuleHit = Pick<Decision, "label" | "is_business" | "confidence" | "rationale" | "rule_id">;

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Deterministic stage: payer list, merchant rules, own-account transfers, exact prior user labels. */
export function applyRules(t: NormalizedTransaction, ctx: CategorizationContext): RuleHit | null {
  const inflow = t.amount < 0;
  const haystack = [t.description, t.normalized_description, ...t.counterparties].map(norm);

  if (inflow) {
    for (const p of ctx.payers) {
      const key = norm(p.counterparty);
      if (key && haystack.some((h) => h.includes(key))) {
        return {
          label: p.is_income ? "income_1099" : "income_other",
          is_business: p.is_income,
          confidence: 1,
          rationale: `payer list: ${p.counterparty}`,
          rule_id: `payer:${p.counterparty}`,
        };
      }
    }
  }

  if (t.merchant_key) {
    const rule = ctx.merchantRules.find((r) => r.merchant_key === t.merchant_key && !r.condition);
    if (rule) {
      return {
        label: rule.label,
        is_business: rule.is_business,
        confidence: 1,
        rationale: `merchant rule for ${rule.merchant_key}`,
        rule_id: `merchant:${rule.merchant_key}`,
      };
    }
  }

  if (ctx.linkedAccountIds.size >= 2 && t.plaid_pfc) {
    if (
      t.plaid_pfc === "TRANSFER_IN_ACCOUNT_TRANSFER" ||
      t.plaid_pfc === "TRANSFER_OUT_ACCOUNT_TRANSFER" ||
      t.plaid_pfc === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"
    ) {
      return {
        label: inflow ? "transfer_in" : "transfer_out",
        is_business: false,
        confidence: 1,
        rationale: "Plaid-flagged transfer between linked accounts",
        rule_id: `transfer:${t.plaid_pfc}`,
      };
    }
  }

  if (t.merchant_key) {
    const prior = ctx.recentUserLabels.find(
      (u) => u.merchant_key === t.merchant_key && Math.sign(u.amount) === Math.sign(t.amount),
    );
    if (prior) {
      return {
        label: prior.label,
        is_business: prior.is_business,
        confidence: 1,
        rationale: `you labeled ${prior.description} as ${prior.label}`,
        rule_id: `prior_label:${t.merchant_key}`,
      };
    }
  }
  return null;
}
