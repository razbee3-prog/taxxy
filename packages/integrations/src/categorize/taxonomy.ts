export const INCOME_LABELS = ["income_1099", "income_other", "refund", "transfer_in"] as const;
export const BUSINESS_EXPENSE_LABELS = [
  "advertising",
  "car_truck",
  "contract_labor",
  "insurance",
  "office",
  "supplies",
  "travel",
  "meals",
  "utilities",
  "software_subscriptions",
  "professional_fees",
  "education",
  "home_office",
  "other_business",
] as const;
export const NON_DEDUCTIBLE_LABELS = [
  "personal",
  "transfer_out",
  "owner_draw",
  "tax_payment",
  "loan_principal",
] as const;
export const PENDING_LABELS = ["uncertain", "needs_receipt"] as const;

export const LABELS = [
  ...INCOME_LABELS,
  ...BUSINESS_EXPENSE_LABELS,
  ...NON_DEDUCTIBLE_LABELS,
  ...PENDING_LABELS,
] as const;
export type Label = (typeof LABELS)[number];

/** Labels the categorizer may emit (pending ones are set by the gate, not the model). */
export const MODEL_LABELS = [
  ...INCOME_LABELS,
  ...BUSINESS_EXPENSE_LABELS,
  ...NON_DEDUCTIBLE_LABELS,
] as const;
export type ModelLabel = (typeof MODEL_LABELS)[number];

/** Schedule C line for each business expense label; `null` = tracked but not an expense line. */
export const SCHEDULE_C_LINE: Record<(typeof BUSINESS_EXPENSE_LABELS)[number], string | null> = {
  advertising: "8",
  car_truck: "9",
  contract_labor: "11",
  insurance: "15",
  office: "18",
  supplies: "22",
  travel: "24a",
  meals: "24b",
  utilities: "25",
  software_subscriptions: "27a",
  professional_fees: "17",
  education: "27a",
  home_office: null,
  other_business: "27a",
};

export const MEALS_DEDUCTIBLE_FRACTION = 0.5;
export const RECEIPT_THRESHOLD = 75;

export function isIncomeLabel(l: Label): boolean {
  return l === "income_1099" || l === "income_other";
}
export function isBusinessExpenseLabel(l: Label): l is (typeof BUSINESS_EXPENSE_LABELS)[number] {
  return (BUSINESS_EXPENSE_LABELS as readonly string[]).includes(l);
}
