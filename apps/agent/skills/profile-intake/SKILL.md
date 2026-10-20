---
name: profile-intake
description: Collect the facts the estimate needs (business, state, W-2 wages and withholding, prior-year totals, health premiums, SEP) and save them with upsert_tax_profile until the profile is complete.
---
# Profile intake

Run this when `get_tax_profile` shows `complete: false` or a field is missing.

Ask in short batches, plain language, one topic per message:
1. What the business does (one sentence) and the state they live in.
2. Any W-2 job this year: expected annual wages and federal withholding (from a recent pay stub). Zero is fine.
3. Last year's return, if they filed: total tax (Form 1040 line 24) and AGI (line 11). Say that these two numbers unlock the prior-year safe harbor, which usually lowers what they must pay now. If they don't have the return handy, continue without it; it can be added later.
4. Self-employed health insurance premiums and any SEP-IRA contribution planned for the year (both optional).
5. Which linked accounts are mostly business (`set_mostly_business`).

Rules:
- Save after every answer with `upsert_tax_profile`; don't wait for the end.
- Prior-year numbers must be confirmed by the user before they count: write `prior_year.confirmed = true` only after they confirm the two numbers you read back.
- When everything is captured, set `complete: true` and summarize the profile in one short paragraph.
- Durable facts (business type, state, safe-harbor choice, payers) also go in AGENTS.md under "Stable facts" via `edit_file`.
- Never ask for an SSN, full account numbers, or login credentials.
