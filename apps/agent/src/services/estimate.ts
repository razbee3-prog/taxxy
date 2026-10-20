import {
  acceptEstimate as dbAcceptEstimate,
  type EstimateRow,
  getTaxProfile,
  insertEstimate,
  listCurrentCategorizations,
  listEstimates,
  scoped,
  type TaxProfile,
} from "@taxxy/db";
import {
  computeEstimate,
  type EstimateInput,
  type EstimateResult,
  getConstants,
  type Quarter,
} from "@taxxy/engine";
import {
  isBusinessExpenseLabel,
  type Label,
  MEALS_DEDUCTIBLE_FRACTION,
  SCHEDULE_C_LINE,
} from "@taxxy/integrations";
import type { AppDeps } from "../deps.js";

export class ProfileIncompleteError extends Error {
  constructor(public readonly missing: string[]) {
    super(`tax profile incomplete: ${missing.join(", ")}`);
    this.name = "ProfileIncompleteError";
  }
}

export interface EstimateOverrides {
  projectionMethod?: "linear" | "manual";
  manualAnnualNetProfit?: number;
  w2Wages?: number;
  w2WithholdingExpectedAnnual?: number;
  seHealthPremiums?: number;
  sepContribution?: number;
  usePriorYear?: boolean;
}

export function missingProfileFields(p: TaxProfile | null): string[] {
  if (!p) return ["profile"];
  const missing: string[] = [];
  if (!p.business_description) missing.push("business_description");
  if (!p.state) missing.push("state");
  if (p.prior_year && !p.prior_year.confirmed) missing.push("prior_year.confirmed");
  return missing;
}

/**
 * Builds the engine input from accepted/auto categorizations through the period end.
 * Business income = income_1099 (money in); expenses = business expense labels by Schedule C line
 * (meals at 50%); pending transactions are excluded. Nothing here computes tax.
 */
export async function buildEstimateInput(
  d: AppDeps,
  userId: string,
  taxYear: number,
  quarter: Quarter,
  overrides: EstimateOverrides = {},
): Promise<{ input: EstimateInput; counts: { income: number; expenses: number } }> {
  const s = scoped(d.db, userId);
  const profile = await getTaxProfile(s);
  const missing = missingProfileFields(profile);
  if (!profile || missing.length) throw new ProfileIncompleteError(missing);
  const c = getConstants(taxYear);
  const periodEnd = c.periodEnds[quarter - 1] as string;
  const from = `${taxYear}-01-01`;
  const rows = await listCurrentCategorizations(s, { statuses: ["auto", "accepted"] });
  let income = 0;
  let incomeCount = 0;
  let expenseCount = 0;
  const expenses: Record<string, number> = {};
  for (const r of rows) {
    const t = r.txn;
    if (t.pending || t.removed || t.date < from || t.date > periodEnd) continue;
    const label = r.label as Label;
    if (label === "income_1099" && t.amount < 0) {
      income += -t.amount;
      incomeCount++;
    } else if (r.is_business && isBusinessExpenseLabel(label) && t.amount > 0) {
      const line = SCHEDULE_C_LINE[label];
      if (!line) continue;
      const amt = label === "meals" ? t.amount * MEALS_DEDUCTIBLE_FRACTION : t.amount;
      expenses[line] = Math.round(((expenses[line] ?? 0) + amt) * 100) / 100;
      expenseCount++;
    }
  }
  const payments = (await listEstimates(s, taxYear))
    .filter((e) => e.status !== "draft" && e.quarter < quarter)
    .map((e) => ({
      amount: Number((e.result as { installmentDue?: number }).installmentDue ?? 0),
      date: String((e.result as { dueDate?: string }).dueDate ?? ""),
    }))
    .filter((p) => p.amount > 0);
  const usePrior = overrides.usePriorYear ?? true;
  const input: EstimateInput = {
    taxYear,
    quarter,
    ytdBusinessIncome: Math.round(income * 100) / 100,
    ytdBusinessExpenses: expenses,
    projectionMethod: overrides.projectionMethod ?? "linear",
    ...(overrides.manualAnnualNetProfit !== undefined
      ? { manualAnnualNetProfit: overrides.manualAnnualNetProfit }
      : {}),
    w2Wages: overrides.w2Wages ?? profile.w2_wages,
    w2WithholdingYtd: 0,
    w2WithholdingExpectedAnnual:
      overrides.w2WithholdingExpectedAnnual ?? profile.w2_withholding_expected,
    priorYear:
      usePrior && profile.prior_year?.confirmed
        ? { totalTax: profile.prior_year.total_tax, agi: profile.prior_year.agi }
        : null,
    seHealthPremiums: overrides.seHealthPremiums ?? profile.se_health_premiums,
    sepContribution: overrides.sepContribution ?? profile.sep_contribution,
    paymentsMadeThisYear: payments,
  };
  return { input, counts: { income: incomeCount, expenses: expenseCount } };
}

export interface ComputedEstimate {
  estimateId: string;
  result: EstimateResult;
  counts: { income: number; expenses: number };
}

/** The only path to a tax dollar figure: engine → `estimate` row → caller. */
export async function computeQuarterlyEstimate(
  d: AppDeps,
  userId: string,
  taxYear: number,
  quarter: Quarter,
  overrides: EstimateOverrides = {},
): Promise<ComputedEstimate> {
  const { input, counts } = await buildEstimateInput(d, userId, taxYear, quarter, overrides);
  const result = computeEstimate(input);
  const row = await insertEstimate(scoped(d.db, userId), {
    tax_year: taxYear,
    quarter,
    input_snapshot: input as unknown as Record<string, unknown>,
    result: result as unknown as Record<string, unknown>,
    engine_version: result.engineVersion,
    constants_version: result.constantsVersion,
  });
  return { estimateId: row.id, result, counts };
}

export async function acceptEstimate(
  d: AppDeps,
  userId: string,
  estimateId: string,
  edits?: Record<string, unknown>,
): Promise<EstimateRow> {
  return dbAcceptEstimate(scoped(d.db, userId), estimateId, edits);
}
