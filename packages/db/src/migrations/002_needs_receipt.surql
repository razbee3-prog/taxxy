-- Pending state "needs_receipt": business item ≥ $75 with no evidence yet (cleared by receipt-matcher).
DEFINE FIELD IF NOT EXISTS needs_receipt ON categorization TYPE bool DEFAULT false;
