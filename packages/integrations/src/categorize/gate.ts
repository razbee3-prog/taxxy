import { isBusinessExpenseLabel, RECEIPT_THRESHOLD } from "./taxonomy.js";
import type { Decision, Status } from "./types.js";

export const DEFAULT_THRESHOLD = 0.8;

export function gate(confidence: number, threshold = DEFAULT_THRESHOLD): Status {
  return confidence >= threshold ? "auto" : "uncertain";
}

/** Business expense ≥ $75 with no evidence attached. */
export function needsReceipt(
  d: Pick<Decision, "label" | "is_business">,
  amount: number,
  hasEvidence: boolean,
): boolean {
  return (
    d.is_business && isBusinessExpenseLabel(d.label) && amount >= RECEIPT_THRESHOLD && !hasEvidence
  );
}

/** A matched receipt raises confidence by 0.1, capped at 1.0. */
export function withEvidence(confidence: number): number {
  return Math.min(1, Math.round((confidence + 0.1) * 1000) / 1000);
}
