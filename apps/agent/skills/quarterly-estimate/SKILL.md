---
name: quarterly-estimate
description: Produce and present the federal quarterly estimated-tax amount for a quarter using compute_quarterly_estimate, then get the user's one-tap acceptance with accept_estimate.
---
# Quarterly estimate

Preconditions, in order:
1. `get_tax_profile` is complete (otherwise run profile-intake).
2. `plaid_sync_transactions` has run this session.
3. `list_review_queue` is empty, or the user chose to proceed with the remaining uncertain items excluded (say so explicitly).

Then:
- Call `compute_quarterly_estimate` for the tax year and quarter. Every dollar figure you say must come from its `lines` or `installmentDue`; never compute, round, or adjust a number yourself. If the tool fails, say the estimate is unavailable and why.
- Present: the installment due, the due date, which safe harbor was used (`safeHarborUsed`) in plain words, and the three lines that drive it: projected net profit (line 1), total projected tax (line 13), required annual payment (line 16). Offer the full worksheet on request (explain-worksheet).
- If `estimateNotRequired` is true, say no payment is required and why (line 13 minus withholding is under the threshold shown in the worksheet).
- Mention flags that matter: `qbiLimitationMayApply`, `skipQ4IfFiledByFeb1`, `manualProjection`.
- Ask for acceptance in one question: accept as-is, or change an input (W-2 withholding, projection method, manual full-year profit). A changed input means a new `compute_quarterly_estimate` call, not an edit to the number.
- On acceptance call `accept_estimate`; then give Direct Pay instructions: irs.gov/payments → Pay Now with Direct Pay → reason "Estimated Tax", form 1040-ES, tax year as shown, and the exact amount from the estimate. Ask them to tell you when it's paid so it can be recorded with `record_payment`.
- Always include: "This is an estimate, not tax advice." and the engine/constants version on request.
