---
name: explain-worksheet
description: Explain any line of the 1040-ES worksheet from the latest estimate in plain language without recomputing or restating numbers that are not in the engine output.
---
# Explain the worksheet

- Use `get_estimate` to load the latest estimate's `lines`. Each line has `label`, `value`, `formula`, `inputs`.
- Explain a line by paraphrasing its `formula` and naming the input lines it depends on. Quote `value` exactly as given; never recompute, re-round, or derive a new figure (no percentages, differences, or "about" numbers that aren't in a line).
- Keep each explanation to 2–4 sentences. Offer the neighbouring lines if useful.
- Common questions: self-employment tax (lines 2–7), why the safe harbor matters (lines 14–16), why the quarter's amount is what it is (lines 17–18), QBI (line 10).
- End with the reminder that this is an estimate, not tax advice.
