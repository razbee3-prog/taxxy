import { getConstants } from "./constants/index.js";
import { cents, clamp0, sum } from "./money.js";
import { inputSnapshotId } from "./snapshot.js";
import type {
  EstimateFlag,
  EstimateInput,
  EstimateResult,
  Line,
  SafeHarbor,
  TaxConstants,
} from "./types.js";

export const ENGINE_VERSION = "1.0.0";
export const DISCLAIMER =
  "Estimate, not tax advice. Computed by the Taxxy engine from the inputs shown; verify before paying.";

const DAYS_IN_YEAR = 365;

function dayOfYear(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const start = Date.UTC(y, 0, 1);
  return (Date.UTC(y, m - 1, d) - start) / 86_400_000 + 1;
}

/** Fraction of the year elapsed at the end of the installment period. */
function forQuarter<T>(arr: readonly [T, T, T, T], quarter: EstimateInput["quarter"]): T {
  return arr[quarter - 1] as T;
}

export function fractionOfYearElapsed(c: TaxConstants, quarter: EstimateInput["quarter"]): number {
  return dayOfYear(forQuarter(c.periodEnds, quarter)) / DAYS_IN_YEAR;
}

export function incomeTax(taxable: number, c: TaxConstants): number {
  let tax = 0;
  let lower = 0;
  for (const b of c.brackets) {
    const upper = b.upTo ?? Number.POSITIVE_INFINITY;
    if (taxable <= lower) break;
    tax += (Math.min(taxable, upper) - lower) * b.rate;
    lower = upper;
  }
  return tax;
}

function validate(input: EstimateInput): void {
  if (![1, 2, 3, 4].includes(input.quarter))
    throw new RangeError(`quarter must be 1-4, got ${input.quarter}`);
  if (input.projectionMethod === "manual" && typeof input.manualAnnualNetProfit !== "number") {
    throw new RangeError("manualAnnualNetProfit is required when projectionMethod is 'manual'");
  }
  for (const [k, v] of Object.entries({
    ytdBusinessIncome: input.ytdBusinessIncome,
    w2Wages: input.w2Wages,
    w2WithholdingYtd: input.w2WithholdingYtd,
    w2WithholdingExpectedAnnual: input.w2WithholdingExpectedAnnual,
    seHealthPremiums: input.seHealthPremiums,
    sepContribution: input.sepContribution,
  })) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`${k} must be a non-negative number`);
  }
}

/**
 * Pure 1040-ES worksheet for a single sole proprietor. The only place in Taxxy that may
 * produce a tax dollar figure. Same input + engine + constants ⇒ byte-identical result.
 */
export function computeEstimate(
  input: EstimateInput,
  constants: TaxConstants = getConstants(input.taxYear),
): EstimateResult {
  validate(input);
  if (constants.taxYear !== input.taxYear) {
    throw new RangeError(`constants are for ${constants.taxYear}, input is for ${input.taxYear}`);
  }
  const c = constants;
  const q = input.quarter;
  const flags = new Set<EstimateFlag>();
  const lines: Line[] = [];
  const line = (id: string, label: string, value: number, formula: string, inputs: string[]) => {
    const v = cents(value);
    lines.push({ id, label, value: v, formula, inputs });
    return v;
  };

  // Projection
  const ytdExpenses = sum(Object.values(input.ytdBusinessExpenses));
  const fraction = fractionOfYearElapsed(c, q);
  let projectedIncome: number;
  let projectedExpenses: number;
  if (input.projectionMethod === "manual") {
    flags.add("manualProjection");
    projectedIncome = input.manualAnnualNetProfit as number;
    projectedExpenses = 0;
  } else {
    projectedIncome = input.ytdBusinessIncome / fraction;
    projectedExpenses = ytdExpenses / fraction;
  }
  const l1 = line(
    "1",
    "Projected net profit",
    projectedIncome - projectedExpenses,
    input.projectionMethod === "manual"
      ? "manualAnnualNetProfit"
      : `(ytdBusinessIncome − ytdBusinessExpenses) ÷ ${fraction.toFixed(4)} (fraction of year through ${forQuarter(c.periodEnds, q)})`,
    ["ytdBusinessIncome", "ytdBusinessExpenses", "projectionMethod"],
  );

  // Self-employment tax
  const l2 = line(
    "2",
    "Net earnings from self-employment",
    clamp0(l1) * c.seEarningsFactor,
    `max(0, line 1) × ${c.seEarningsFactor}`,
    ["1"],
  );
  const seApplies = l2 >= c.seTaxFloor;
  if (!seApplies) flags.add("seTaxBelowFloor");
  const ssRoom = clamp0(c.socialSecurityWageBase - input.w2Wages);
  const l3 = line(
    "3",
    "Social Security tax",
    seApplies ? Math.min(l2, ssRoom) * c.socialSecurityRate : 0,
    `min(line 2, ${c.socialSecurityWageBase} − w2Wages) × ${c.socialSecurityRate}${seApplies ? "" : `; 0 because line 2 < ${c.seTaxFloor}`}`,
    ["2", "w2Wages"],
  );
  const l4 = line(
    "4",
    "Medicare tax",
    seApplies ? l2 * c.medicareRate : 0,
    `line 2 × ${c.medicareRate}`,
    ["2"],
  );
  const l5 = line(
    "5",
    "Additional Medicare tax",
    seApplies
      ? clamp0(l2 + input.w2Wages - c.additionalMedicareThreshold) * c.additionalMedicareRate
      : 0,
    `max(0, line 2 + w2Wages − ${c.additionalMedicareThreshold}) × ${c.additionalMedicareRate}`,
    ["2", "w2Wages"],
  );
  const l6 = line("6", "Self-employment tax", l3 + l4 + l5, "line 3 + line 4 + line 5", [
    "3",
    "4",
    "5",
  ]);
  const l7 = line("7", "Deductible half of SE tax", (l3 + l4) * 0.5, "(line 3 + line 4) × 0.5", [
    "3",
    "4",
  ]);

  // Income tax
  const l8 = line(
    "8",
    "Adjusted gross income",
    l1 + input.w2Wages - l7 - input.seHealthPremiums - input.sepContribution,
    "line 1 + w2Wages − line 7 − seHealthPremiums − sepContribution",
    ["1", "w2Wages", "7", "seHealthPremiums", "sepContribution"],
  );
  const l9 = line(
    "9",
    "Taxable income before QBI deduction",
    clamp0(l8 - c.standardDeduction),
    `max(0, line 8 − ${c.standardDeduction})`,
    ["8"],
  );
  const qbiBase = clamp0(l1 - l7 - input.seHealthPremiums - input.sepContribution);
  let qbi = Math.min(c.qbiRate * qbiBase, c.qbiRate * l9);
  if (qbiBase >= c.qbiMinimumDeductionFloor && qbi < c.qbiMinimumDeduction) {
    qbi = c.qbiMinimumDeduction;
    flags.add("qbiMinimumApplied");
  }
  if (l9 > c.qbiThreshold) flags.add("qbiLimitationMayApply");
  const l10 = line(
    "10",
    "Qualified business income deduction",
    qbi,
    `min(${c.qbiRate} × (line 1 − line 7 − seHealthPremiums − sepContribution), ${c.qbiRate} × line 9); at least ${c.qbiMinimumDeduction} when QBI ≥ ${c.qbiMinimumDeductionFloor}`,
    ["1", "7", "9", "seHealthPremiums", "sepContribution"],
  );
  const l11 = line("11", "Taxable income", clamp0(l9 - l10), "line 9 − line 10", ["9", "10"]);
  const l12 = line(
    "12",
    "Income tax",
    incomeTax(l11, c),
    `${c.taxYear} single bracket schedule applied to line 11`,
    ["11"],
  );
  const l13 = line("13", "Total projected tax", l12 + l6, "line 12 + line 6", ["12", "6"]);

  // Required annual payment
  const l14 = line(
    "14",
    "Current-year safe harbor target",
    l13 * c.currentYearSafeHarbor,
    `line 13 × ${c.currentYearSafeHarbor}`,
    ["13"],
  );
  const prior = input.priorYear ?? null;
  let safeHarborUsed: SafeHarbor = "currentYear";
  let l15: number | null = null;
  if (prior) {
    const high = prior.agi > c.priorYearHighIncomeAgi;
    if (high) flags.add("priorYearHighIncome");
    const mult = high ? c.priorYearHighIncomeSafeHarbor : c.priorYearSafeHarbor;
    l15 = line(
      "15",
      "Prior-year safe harbor target",
      prior.totalTax * mult,
      `priorYear.totalTax × ${mult}${high ? ` (prior AGI > ${c.priorYearHighIncomeAgi})` : ""}`,
      ["priorYear.totalTax", "priorYear.agi"],
    );
    if (l15 < l14) safeHarborUsed = high ? "priorYear110" : "priorYear";
  } else {
    flags.add("noPriorYear");
    lines.push({
      id: "15",
      label: "Prior-year safe harbor target",
      value: 0,
      formula: "not available: no prior-year return",
      inputs: [],
    });
  }
  const l16 = line(
    "16",
    "Required annual payment",
    l15 === null ? l14 : Math.min(l14, l15),
    prior ? "min(line 14, line 15)" : "line 14",
    prior ? ["14", "15"] : ["14"],
  );
  const frac = forQuarter(c.installmentFractions, q);
  const l17 = line("17", `Cumulative required through Q${q}`, l16 * frac, `line 16 × ${frac}`, [
    "16",
  ]);
  const withholdingCredit = input.w2WithholdingExpectedAnnual * frac;
  const paid = sum(input.paymentsMadeThisYear.map((p) => p.amount));
  const l18 = line(
    "18",
    "Installment due",
    clamp0(l17 - withholdingCredit - paid),
    `max(0, line 17 − w2WithholdingExpectedAnnual × ${frac} − paymentsMadeThisYear)`,
    ["17", "w2WithholdingExpectedAnnual", "paymentsMadeThisYear"],
  );
  const dueDate = forQuarter(c.dueDates, q);
  lines.push({ id: "19", label: "Due date", value: 0, formula: dueDate, inputs: ["quarter"] });
  if (q === 4) flags.add("skipQ4IfFiledByFeb1");

  const estimateNotRequired = l13 - input.w2WithholdingExpectedAnnual < c.estimateThreshold;
  if (estimateNotRequired) flags.add("estimateNotRequired");

  return {
    taxYear: input.taxYear,
    quarter: q,
    installmentDue: estimateNotRequired ? 0 : l18,
    dueDate,
    safeHarborUsed,
    estimateNotRequired,
    lines,
    flags: [...flags].sort(),
    inputSnapshotId: inputSnapshotId(input),
    engineVersion: ENGINE_VERSION,
    constantsVersion: c.constantsVersion,
    disclaimer: DISCLAIMER,
  };
}
