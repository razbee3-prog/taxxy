export type Quarter = 1 | 2 | 3 | 4;

export interface Bracket {
  /** Upper bound of taxable income for this bracket; null = no upper bound. */
  upTo: number | null;
  rate: number;
}

export interface TaxConstants {
  taxYear: number;
  constantsVersion: string;
  filingStatus: "single";
  seEarningsFactor: number;
  socialSecurityRate: number;
  medicareRate: number;
  additionalMedicareRate: number;
  socialSecurityWageBase: number;
  additionalMedicareThreshold: number;
  seTaxFloor: number;
  standardDeduction: number;
  brackets: Bracket[];
  qbiRate: number;
  qbiThreshold: number;
  qbiMinimumDeduction: number;
  qbiMinimumDeductionFloor: number;
  currentYearSafeHarbor: number;
  priorYearSafeHarbor: number;
  priorYearHighIncomeSafeHarbor: number;
  priorYearHighIncomeAgi: number;
  estimateThreshold: number;
  /** ISO dates, index = quarter − 1. */
  dueDates: [string, string, string, string];
  periodEnds: [string, string, string, string];
  installmentFractions: [number, number, number, number];
}

export interface PriorYear {
  totalTax: number;
  agi: number;
}

export interface PaymentMade {
  amount: number;
  /** ISO date. */
  date: string;
}

export interface EstimateInput {
  taxYear: number;
  quarter: Quarter;
  /** Gross Schedule C receipts, year to date through the period end. */
  ytdBusinessIncome: number;
  /** Schedule C expenses by line id (e.g. "27a"), year to date through the period end. */
  ytdBusinessExpenses: Record<string, number>;
  projectionMethod: "linear" | "manual";
  /** Full-year net profit the user supplied; required when projectionMethod = "manual". */
  manualAnnualNetProfit?: number;
  w2Wages: number;
  w2WithholdingYtd: number;
  w2WithholdingExpectedAnnual: number;
  priorYear?: PriorYear | null;
  seHealthPremiums: number;
  sepContribution: number;
  paymentsMadeThisYear: PaymentMade[];
}

export interface Line {
  id: string;
  label: string;
  value: number;
  formula: string;
  inputs: string[];
}

export type SafeHarbor = "currentYear" | "priorYear" | "priorYear110";

export type EstimateFlag =
  | "estimateNotRequired"
  | "seTaxBelowFloor"
  | "qbiLimitationMayApply"
  | "qbiMinimumApplied"
  | "noPriorYear"
  | "priorYearHighIncome"
  | "skipQ4IfFiledByFeb1"
  | "manualProjection";

export interface EstimateResult {
  taxYear: number;
  quarter: Quarter;
  installmentDue: number;
  dueDate: string;
  safeHarborUsed: SafeHarbor;
  estimateNotRequired: boolean;
  lines: Line[];
  flags: EstimateFlag[];
  inputSnapshotId: string;
  engineVersion: string;
  constantsVersion: string;
  disclaimer: string;
}
