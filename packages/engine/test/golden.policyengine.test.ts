import { describe, expect, it } from "vitest";
import { computeEstimate } from "../src/index.js";
import oracle from "./fixtures/policyengine-2026.json" with { type: "json" };
import { annualInput, lineValue } from "./helpers.js";

interface OracleCase {
  netProfit: number;
  w2Wages: number;
  self_employment_tax: number;
  additional_medicare_tax: number;
  self_employment_tax_ald: number;
  adjusted_gross_income: number;
  qualified_business_income_deduction: number;
  taxable_income: number;
  income_tax_main_rates: number;
}

const TOL = 1.0; // dollars; PolicyEngine rounds some intermediate lines

describe(`Tier 1 golden: PolicyEngine US oracle (${oracle.source}, ${oracle.taxYear})`, () => {
  for (const c of oracle.cases as OracleCase[]) {
    const name = `net profit ${c.netProfit}, W-2 wages ${c.w2Wages}`;
    it(name, () => {
      const r = computeEstimate(
        annualInput({ ytdBusinessIncome: c.netProfit, w2Wages: c.w2Wages }),
      );
      const L = (id: string) => lineValue(r.lines, id);
      // PolicyEngine's self_employment_tax excludes the Additional Medicare tax (separate variable).
      expect(L("3") + L("4")).toBeCloseTo(c.self_employment_tax, -0);
      expect(Math.abs(L("3") + L("4") - c.self_employment_tax)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(L("5") - c.additional_medicare_tax)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(L("7") - c.self_employment_tax_ald)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(L("8") - c.adjusted_gross_income)).toBeLessThanOrEqual(TOL);
      if (r.flags.includes("qbiLimitationMayApply")) {
        // Spec: phase-in above the QBI threshold is flagged, not modelled, so only SE lines are asserted.
        return;
      }
      expect(Math.abs(L("10") - c.qualified_business_income_deduction)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(L("11") - c.taxable_income)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(L("12") - c.income_tax_main_rates)).toBeLessThanOrEqual(TOL);
    });
  }
});
