import type { EstimateInput } from "../src/types.js";

/** Full-year inputs (Q4, linear projection ⇒ projected = YTD). */
export function annualInput(over: Partial<EstimateInput> = {}): EstimateInput {
  return {
    taxYear: 2026,
    quarter: 4,
    ytdBusinessIncome: 60_000,
    ytdBusinessExpenses: {},
    projectionMethod: "linear",
    w2Wages: 0,
    w2WithholdingYtd: 0,
    w2WithholdingExpectedAnnual: 0,
    priorYear: null,
    seHealthPremiums: 0,
    sepContribution: 0,
    paymentsMadeThisYear: [],
    ...over,
  };
}

export function lineValue(lines: { id: string; value: number }[], id: string): number {
  const l = lines.find((x) => x.id === id);
  if (!l) throw new Error(`missing line ${id}`);
  return l.value;
}
