import { describe, expect, it } from "vitest";
import { computeEstimate, getConstants, incomeTax, UnsupportedTaxYearError } from "../src/index.js";
import { annualInput, lineValue } from "./helpers.js";

/**
 * Hand-worked 1040-ES worksheet examples (Pub 505 method, 2026 single constants).
 * Net profit 60,000, no W-2:
 *   2: 60,000 × 0.9235 = 55,410.00
 *   3: 55,410 × 0.124 = 6,870.84      4: 55,410 × 0.029 = 1,606.89      6: 8,477.73
 *   7: 8,477.73 / 2 = 4,238.87 (cents rounding of 4,238.865)
 *   8: 60,000 − 4,238.87 = 55,761.13   9: 55,761.13 − 16,100 = 39,661.13
 *  10: min(0.2 × 55,761.13, 0.2 × 39,661.13) = 7,932.23 (0.2 × 39,661.13 = 7,932.226)
 *  11: 31,728.90   12: 1,240 + (31,728.90 − 12,400) × 0.12 = 3,559.47 (3,559.468)
 *  13: 12,037.20   14: 10,833.48
 */
describe("worksheet, hand-computed", () => {
  it("60k sole proprietor, no prior year, Q4", () => {
    const r = computeEstimate(annualInput());
    const L = (id: string) => lineValue(r.lines, id);
    expect(L("1")).toBe(60_000);
    expect(L("2")).toBe(55_410);
    expect(L("3")).toBe(6_870.84);
    expect(L("4")).toBe(1_606.89);
    expect(L("5")).toBe(0);
    expect(L("6")).toBe(8_477.73);
    expect(L("7")).toBe(4_238.87);
    expect(L("8")).toBe(55_761.13);
    expect(L("9")).toBe(39_661.13);
    expect(L("10")).toBe(7_932.23);
    expect(L("11")).toBe(31_728.9);
    expect(L("12")).toBe(3_559.47);
    expect(L("13")).toBe(12_037.2);
    expect(L("14")).toBe(10_833.48);
    expect(L("16")).toBe(10_833.48);
    expect(L("17")).toBe(10_833.48);
    expect(r.installmentDue).toBe(10_833.48);
    expect(r.safeHarborUsed).toBe("currentYear");
    expect(r.dueDate).toBe("2027-01-15");
    expect(r.flags).toEqual(["noPriorYear", "skipQ4IfFiledByFeb1"]);
    expect(r.lines.map((l) => l.id)).toEqual(Array.from({ length: 19 }, (_, i) => String(i + 1)));
  });

  it("2026 single bracket schedule boundaries", () => {
    const c = getConstants(2026);
    expect(incomeTax(0, c)).toBe(0);
    expect(incomeTax(12_400, c)).toBe(1_240);
    expect(incomeTax(50_400, c)).toBeCloseTo(1_240 + 38_000 * 0.12, 6);
    expect(incomeTax(105_700, c)).toBeCloseTo(5_800 + 55_300 * 0.22, 6);
    expect(incomeTax(201_775, c)).toBeCloseTo(17_966 + 96_075 * 0.24, 6);
    expect(incomeTax(256_225, c)).toBeCloseTo(41_024 + 54_450 * 0.32, 6);
    expect(incomeTax(640_600, c)).toBeCloseTo(58_448 + 384_375 * 0.35, 6);
    expect(incomeTax(700_000, c)).toBeCloseTo(192_979.25 + 59_400 * 0.37, 6);
  });

  it("prior-year 100% safe harbor wins when smaller", () => {
    const r = computeEstimate(annualInput({ priorYear: { totalTax: 8_000, agi: 70_000 } }));
    expect(lineValue(r.lines, "15")).toBe(8_000);
    expect(lineValue(r.lines, "16")).toBe(8_000);
    expect(r.safeHarborUsed).toBe("priorYear");
    expect(r.installmentDue).toBe(8_000);
  });

  it("prior-year 110% when prior AGI > 150k", () => {
    const r = computeEstimate(annualInput({ priorYear: { totalTax: 9_000, agi: 160_000 } }));
    expect(lineValue(r.lines, "15")).toBe(9_900);
    expect(r.safeHarborUsed).toBe("priorYear110");
    expect(r.flags).toContain("priorYearHighIncome");
  });

  it("current-year target wins when prior year is larger", () => {
    const r = computeEstimate(annualInput({ priorYear: { totalTax: 30_000, agi: 90_000 } }));
    expect(r.safeHarborUsed).toBe("currentYear");
    expect(lineValue(r.lines, "16")).toBe(10_833.48);
  });

  it("quarters: cumulative fraction, withholding credit and payments", () => {
    const base = {
      priorYear: { totalTax: 8_000, agi: 70_000 },
      w2WithholdingExpectedAnnual: 2_000,
    };
    const q1 = computeEstimate(
      annualInput({ ...base, quarter: 1, ytdBusinessIncome: 60_000 * (90 / 365) }),
    );
    expect(lineValue(q1.lines, "17")).toBe(2_000);
    expect(q1.installmentDue).toBe(1_500); // 2,000 − 2,000 × 0.25
    expect(q1.dueDate).toBe("2026-04-15");
    const q2 = computeEstimate(
      annualInput({
        ...base,
        quarter: 2,
        ytdBusinessIncome: 60_000 * (151 / 365),
        paymentsMadeThisYear: [{ amount: 1_500, date: "2026-04-10" }],
      }),
    );
    expect(lineValue(q2.lines, "17")).toBe(4_000);
    expect(q2.installmentDue).toBe(1_500); // 4,000 − 1,000 − 1,500
    expect(q2.dueDate).toBe("2026-06-15");
    const q3 = computeEstimate(
      annualInput({ ...base, quarter: 3, ytdBusinessIncome: 60_000 * (243 / 365) }),
    );
    expect(q3.dueDate).toBe("2026-09-15");
    expect(q3.flags).not.toContain("skipQ4IfFiledByFeb1");
  });

  it("linear projection scales YTD income and expenses by fraction of year", () => {
    const r = computeEstimate(
      annualInput({
        quarter: 1,
        ytdBusinessIncome: 9_000,
        ytdBusinessExpenses: { "27a": 1_000, "8": 500 },
      }),
    );
    expect(lineValue(r.lines, "1")).toBe(Math.round((7_500 / (90 / 365)) * 100) / 100);
  });

  it("manual projection uses the user's full-year figure", () => {
    const r = computeEstimate(
      annualInput({
        quarter: 2,
        projectionMethod: "manual",
        manualAnnualNetProfit: 80_000,
        ytdBusinessIncome: 1,
      }),
    );
    expect(lineValue(r.lines, "1")).toBe(80_000);
    expect(r.flags).toContain("manualProjection");
  });

  it("W-2 wages reduce the Social Security room and count toward Additional Medicare", () => {
    const r = computeEstimate(annualInput({ ytdBusinessIncome: 100_000, w2Wages: 150_000 }));
    const L = (id: string) => lineValue(r.lines, id);
    expect(L("3")).toBe(Math.round((184_500 - 150_000) * 0.124 * 100) / 100);
    expect(L("5")).toBe(Math.round((92_350 + 150_000 - 200_000) * 0.009 * 100) / 100);
  });
});

describe("edge cases", () => {
  it("net SE earnings under $400: no SE tax, flagged", () => {
    const r = computeEstimate(annualInput({ ytdBusinessIncome: 400 }));
    expect(lineValue(r.lines, "2")).toBe(369.4);
    expect(lineValue(r.lines, "6")).toBe(0);
    expect(r.flags).toContain("seTaxBelowFloor");
    expect(r.flags).toContain("estimateNotRequired");
    expect(r.installmentDue).toBe(0);
  });

  it("balance under $1,000 after withholding: estimateNotRequired with the worksheet still filled", () => {
    const r = computeEstimate(annualInput({ w2WithholdingExpectedAnnual: 11_500 }));
    expect(r.estimateNotRequired).toBe(true);
    expect(r.installmentDue).toBe(0);
    expect(lineValue(r.lines, "13")).toBe(12_037.2);
    expect(r.lines).toHaveLength(19);
  });

  it("Q4 carries the skipQ4IfFiledByFeb1 flag and Jan 15 2027 due date", () => {
    const r = computeEstimate(annualInput({ quarter: 4 }));
    expect(r.flags).toContain("skipQ4IfFiledByFeb1");
    expect(r.dueDate).toBe("2027-01-15");
  });

  it("QBI above the threshold is flagged, not modelled", () => {
    const r = computeEstimate(annualInput({ ytdBusinessIncome: 260_000 }));
    expect(r.flags).toContain("qbiLimitationMayApply");
  });

  it("QBI $400 minimum applies when QBI ≥ $1,000 but 20% of taxable income is below $400", () => {
    const r = computeEstimate(annualInput({ ytdBusinessIncome: 17_000 }));
    // line 9 ≈ 17,000 − 1,201 − 16,100 < 2,000 ⇒ 20% < 400 ⇒ floor
    expect(lineValue(r.lines, "10")).toBe(400);
    expect(r.flags).toContain("qbiMinimumApplied");
  });

  it("refuses unsupported tax years and bad inputs", () => {
    expect(() => computeEstimate(annualInput({ taxYear: 2025 }))).toThrow(UnsupportedTaxYearError);
    expect(() => getConstants(2031)).toThrow(/not supported/);
    expect(() => computeEstimate(annualInput({ quarter: 5 as 1 }))).toThrow(RangeError);
    expect(() => computeEstimate(annualInput({ projectionMethod: "manual" }))).toThrow(
      /manualAnnualNetProfit/,
    );
    expect(() => computeEstimate(annualInput({ w2Wages: -1 }))).toThrow(RangeError);
  });
});
