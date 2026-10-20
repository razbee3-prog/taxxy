# Taxxy v1 — Agent Architecture & Build Spec

Oct 19, 2026 · @raz

## Summary and scope

Taxxy v1 is an on-demand TypeScript deep agent that turns a sole proprietor's linked bank data into a federal quarterly estimated tax amount the user accepts in one tap. It runs on the deepagents.js harness, uses Plaid Transactions for income and expenses, Gmail for receipts and the prior-year 1040, SurrealDB for state and memory, Langfuse for tracing and evals, and a deterministic tax engine for every number. Devin builds it; this doc is the handoff.

|  | In v1 | Not in v1 (see Backlog) |
| --- | --- | --- |
| User | US sole proprietor with 1099 income, single filer, no dependents | MFJ, dependents, credits, S-corp, LLC taxed otherwise |
| Tax | Federal 1040-ES estimate, prior-year safe harbor default, current-year fallback | State (NY/NYC first), annualized method, annual filing |
| Data | Plaid Transactions sync; Gmail receipts/invoices; optional prior-year 1040 (PDF upload or Gmail) | Invoicing tools, accounting software |
| Categorization | Rules then LLM; auto-decide at or above 0.80 confidence, else user decides | Fine-tuned classifier |
| Payment | Computes amount, shows IRS Direct Pay instructions | Browser subagent submits on Direct Pay (vault + interrupt reserved now) |
| Cadence | On demand (user opens chat) | Scheduled sync, deadline nudges |
| Surface | Web app: account, bank link, chat | UI design (out of this spec) |

Definition of done for v1: a user links a bank, answers the intake, reviews only the transactions Taxxy was unsure about, and gets a Q4 2026 estimate (due Jan 15, 2027) with a line-by-line worksheet they accept without edits at least 70% of the time on the golden profiles.

## User and jobs to be done

The user is a US sole proprietor paid on 1099s (creator, consultant, contractor) who mixes business and personal spend on the same cards and has never used EFTPS. They want the number, the deadline, and proof they won't be penalized, without doing bookkeeping.

| Job | What Taxxy does | Done when |
| --- | --- | --- |
| 1. Know what I owe this quarter | Syncs transactions, separates business from personal, computes the 1040-ES installment | User sees amount, due date, and the worksheet behind it |
| 2. Don't make me sort every transaction | Auto-categorizes confident items; queues only uncertain ones | Uncategorized rate after review is 0 |
| 3. Trust the math | Deterministic engine, every line editable, safe-harbor choice explained | User accepts without edits |
| 4. Remember me | Intake once; payers, merchants, and choices persist across sessions | No repeated questions across quarters |

Success metrics (defined in Evals): uncategorized-transaction rate, tax-calculation editing rate, acceptance rate.

## Architecture overview

One deep agent orchestrates; subagents do isolated batch work; the tax engine is a plain TypeScript function the orchestrator calls as a tool.

&#91;embedded content: Taxxy v1 architecture: web app, orchestrator, 3 subagents, tools, shared services\]

The orchestrator holds the conversation and per-user memory, delegates batch categorization and receipt matching to stateless subagents, and calls the tax engine directly. SurrealDB and Langfuse sit under every layer. Dashed boxes are backlog but have reserved slots so adding them changes no interfaces.

## Agent design

The orchestrator is one `createDeepAgent` instance per request, scoped to the user by `thread_id` and `user_id`; it never does arithmetic and never sees SSNs or account numbers.

### Orchestrator configuration

| Setting | Value |
| --- | --- |
| Harness | deepagents.js (`deepagents` npm, v1.10+), LangGraph.js runtime |
| Model | One frontier model (Claude Sonnet class or equivalent), temperature 0 |
| Backend | `StoreBackend` over `SurrealDBStore`; virtual filesystem rooted at `/users/{userId}/` |
| Memory | `memory: ["/users/{userId}/AGENTS.md"]` loaded every turn; agent may append to it via `edit_file` |
| Checkpointer | `SurrealDBSaver` (one thread per user per quarter: `{userId}:{taxYear}:{quarter}`) |
| Skills | `profile-intake`, `quarterly-estimate`, `review-queue`, `explain-worksheet` (SKILL.md files in the store) |
| Subagents | `categorizer`, `receipt-matcher`, `payment-executor` (registered, tool-gated off in v1) |
| interruptOn | `submit_payment: true`, `delete_bank_account: true`, `bulk_recategorize: true` |
| Filesystem tools | `read_file`, `edit_file`, `ls` only (no `execute`, no sandbox) |
| Context | Default summarization middleware on; tool results over 20 KB offloaded to the filesystem |
| Callbacks | Langfuse `CallbackHandler` with `userId`, `sessionId`, tags `[taxYear, quarter, agent]` |

System prompt responsibilities, in order: run intake until `TaxProfile.complete`; sync and categorize; resolve the review queue; compute and present the estimate; explain any line on request; update AGENTS.md with durable facts (payers, merchant rules, safe-harbor choice). It must refuse to state a dollar figure that did not come from `compute_quarterly_estimate`.

### AGENTS.md (per user) holds

- Stable facts: filing status, state, business type, business account IDs
- Payer list: counterparty name → income, with the date the user confirmed it
- Merchant rules the user set ("Adobe is always business", "Uber is personal unless weekday 9-6")
- Safe-harbor method chosen and prior-year numbers once confirmed
- Tone preferences the user stated

Transactions, categorization decisions, estimates and receipts live in SurrealDB tables, not in memory files.

### Subagents (stateless, one report back)

| Subagent | Input | Output | Model |
| --- | --- | --- | --- |
| `categorizer` | Batch of up to 200 uncategorized transactions + user's merchant rules + payer list | Per-transaction `{category, isBusiness, confidence, rationale, evidenceRefs}` | Cheaper model, structured output, temperature 0 |
| `receipt-matcher` | Date window + list of transactions lacking evidence | Gmail message IDs matched to transaction IDs with match score; parsed receipt totals | Cheaper model |
| `payment-executor` (backlog) | Estimate ID, due date | Confirmation number or failure reason | Frontier model + browser tool; vault fills identity and bank fields |

Intake is not a subagent: subagents cannot hold a multi-turn conversation, so the orchestrator runs the `profile-intake` skill itself and writes through `upsert_tax_profile`.

### Tool contracts

| Tool | Signature (TypeScript, Zod-validated) | Side effects |
| --- | --- | --- |
| `plaid_create_link_token` | `(userId) → {linkToken}` | none |
| `plaid_exchange_public_token` | `(userId, publicToken) → {itemId, accounts[]}` | stores encrypted access token |
| `plaid_sync_transactions` | `(userId, itemId?) → {added, modified, removed, cursor}` | upserts `transaction` rows |
| `get_tax_profile` | `(userId) → TaxProfile` | none |
| `upsert_tax_profile` | `(userId, patch: Partial<TaxProfile>) → TaxProfile` | writes `tax_profile`, audit event |
| `list_review_queue` | `(userId, limit) → Transaction[]` with confidence < 0.80 or flagged | none |
| `record_categorization` | \`(userId, txnId, category, isBusiness, source: 'rule' | 'llm' |
| `set_merchant_rule` | `(userId, merchantKey, rule) → void` | writes `merchant_rule`, mirrors to AGENTS.md |
| `set_payer` | `(userId, counterparty, isIncome) → void` | writes `payer`, mirrors to AGENTS.md |
| `gmail_search_receipts` | `(userId, from, to, query?) → MessageSummary[]` | none (read-only scope) |
| `gmail_fetch_attachment` | `(userId, messageId, attachmentId) → {bytes, mime}` | stores in object storage |
| `extract_prior_year_1040` | `(userId, fileRef) → {totalTax, agi, filingStatus, confidence}` | writes `tax_profile.priorYear` as unconfirmed |
| `compute_quarterly_estimate` | `(userId, taxYear, quarter, overrides?) → EstimateResult` | writes `estimate` row with input snapshot |
| `accept_estimate` | `(userId, estimateId, edits?) → void` | sets status accepted/edited; emits Langfuse score |
| `submit_payment` (backlog) | `(userId, estimateId) → {confirmation}` | interrupt before browser submit |

Every tool takes `userId` from the LangGraph `configurable` context, never from model output, and rejects a mismatch.

### Human-in-the-loop

- Review queue is the primary HITL surface: the orchestrator presents uncertain transactions in batches of 10 with its best guess preselected.
- `interruptOn` covers irreversible or money-adjacent tools only; categorization confirmations are ordinary chat turns.
- Auto-decided items (confidence ≥ 0.80) appear in a "decided for you" digest each session with one-tap undo; undo writes a user label.

## Tax engine

The engine is a pure TypeScript package (`@taxxy/engine`) with no I/O: `computeEstimate(input, constants) → EstimateResult`. Constants live in `constants/2026.ts`; the engine refuses a tax year it has no file for.

### Inputs

| Field | Source | Notes |
| --- | --- | --- |
| `ytdBusinessIncome`, `ytdBusinessExpenses` by Schedule C line | `categorization` rows with status accepted or auto | Through the installment period end date |
| `projectionMethod` | default `linear`; user may set `manual` with a full-year figure | linear = YTD net profit ÷ fraction of year elapsed |
| `w2Wages`, `w2WithholdingYtd`, `w2WithholdingExpectedAnnual` | TaxProfile | Withholding is treated as paid evenly across installments |
| `priorYear.totalTax`, `priorYear.agi` | TaxProfile (optional, user-confirmed) | Absent → current-year method only |
| `seHealthPremiums`, `sepContribution` | TaxProfile | Above-the-line adjustments |
| `paymentsMadeThisYear[]` | `payment` rows or user-entered | Credited against cumulative required amount |
| `quarter` | 1-4 | Period ends Mar 31, May 31, Aug 31, Dec 31 |

### Worksheet (every line returned, labeled, editable)

1. Projected net profit = projected income − projected Schedule C expenses
2. Net SE earnings = line 1 × 0.9235
3. Social Security tax = min(line 2, 184,500 − W-2 Social Security wages) × 0.124
4. Medicare tax = line 2 × 0.029
5. Additional Medicare = max(0, (line 2 + W-2 wages) − 200,000) × 0.009
6. SE tax = 3 + 4 + 5
7. Half SE deduction = (3 + 4) × 0.5
8. AGI = line 1 + W-2 wages − line 7 − SE health premiums − SEP contribution
9. Taxable income before QBI = max(0, line 8 − 16,100)
10. QBI deduction = min(0.20 × (line 1 − line 7 − SE health − SEP), 0.20 × line 9); if line 9 > 201,750 flag `qbiLimitationMayApply` (phase-in not modeled); floor at 400 when QBI ≥ 1,000
11. Taxable income = line 9 − line 10
12. Income tax = bracket function (2026 single) on line 11
13. Total projected tax = line 12 + line 6
14. Current-year target = 0.90 × line 13
15. Prior-year target = priorYear.totalTax × (priorYear.agi > 150,000 ? 1.10 : 1.00); null if no prior year
16. Required annual = min(non-null of 14, 15); `safeHarborUsed` names which
17. Cumulative required through this quarter = line 16 × (0.25, 0.50, 0.75, 1.00)
18. Installment due = max(0, line 17 − withholding credited to date (expected annual × the same fraction) − payments made)
19. Due date for the quarter; `skipQ4IfFiledByFeb1` flag on Q4

If line 13 − withholding < 1,000 the engine returns `estimateNotRequired: true` with the worksheet still filled.

### 2026 constants (`constants/2026.ts`, verified against Rev. Proc. 2025-32)

| Constant | Value |
| --- | --- |
| SE tax rate | 15.3% (12.4% OASDI + 2.9% Medicare) on 92.35% of net profit |
| Social Security wage base | $184,500 |
| Additional Medicare threshold (single) | $200,000 at 0.9% |
| SE tax floor | $400 net SE earnings |
| Standard deduction (single) | $16,100 |
| Brackets (single) | 10% to $12,400; 12% to $50,400; 22% to $105,700; 24% to $201,775; 32% to $256,225; 35% to $640,600; 37% above |
| QBI | 20%; threshold $201,750 single; $400 minimum when QBI ≥ $1,000 |
| Safe harbor | 90% current year; 100% prior year, 110% if prior AGI > $150,000 |
| Estimate threshold | $1,000 balance after withholding |
| Due dates | Apr 15 2026, Jun 15 2026, Sep 15 2026, Jan 15 2027 |

### Output

`EstimateResult` = `{ installmentDue, dueDate, safeHarborUsed, lines: Line[], flags: string[], inputSnapshotId, engineVersion, constantsVersion }` where each `Line` is `{ id, label, value, formula, inputs[] }`. The orchestrator renders lines verbatim; the explainer skill may paraphrase `formula` but never recompute `value`.

Determinism rule: same `inputSnapshotId` + `engineVersion` + `constantsVersion` must reproduce the same result byte for byte; this is asserted in CI.

Sources: [Rev. Proc. 2025-32 analysis](https://www.currentfederaltaxdevelopments.com/blog/2025/10/9/2026-inflation-adjustments-for-tax-professionals-revenue-procedure-2025-32-analysis) · [2026 brackets and standard deduction](https://blog.surgentcpe.com/2026-irs-tax-changes) · [2026 QBI thresholds](https://nationaltaxtools.com/guides/qbi-deduction/) · [SE tax and 2026 wage base](https://quickbooks.intuit.com/r/taxes/complete-guide-to-taxes-for-the-self-employed-pillar) · [1040-ES due dates and safe harbor](https://ustax.tools/estimated-tax-due-dates-2026/)

## Categorization pipeline

Every transaction gets a label from one of three sources in order: a rule, the LLM, or the user. A rule or LLM label with confidence ≥ 0.80 is applied automatically; anything lower waits for the user.

### Taxonomy

| Group | Labels |
| --- | --- |
| Income | `income_1099` (counterparty in payer list or inferred), `income_other`, `refund`, `transfer_in` |
| Business expense (Schedule C line) | `advertising`, `car_truck`, `contract_labor`, `insurance`, `office`, `supplies`, `travel`, `meals` (50% flag), `utilities`, `software_subscriptions` (other expenses), `professional_fees`, `education`, `home_office` (flag only, computed in intake), `other_business` |
| Non-deductible | `personal`, `transfer_out`, `owner_draw`, `tax_payment`, `loan_principal` |
| Pending | `uncertain` (confidence < 0.80), `needs_receipt` (business but amount ≥ $75 and no evidence) |

### Stages

1. Normalize: strip card suffixes, dates, invoice numbers from `description`; derive `merchantKey`; use Plaid `personal_finance_category` and `counterparties` as features only.
2. Rules (deterministic, confidence 1.0): payer list → `income_1099`; merchant rules; Plaid-flagged transfers between the user's own linked accounts → `transfer_*`; exact duplicates of a prior user label for the same `merchantKey` and sign.
3. LLM (`categorizer` subagent): batch of up to 200 with the user's business description, merchant rules, and 20 recent user labels as few-shot. Structured output per transaction: `{label, isBusiness, confidence ∈ [0,1], rationale ≤ 20 words}`. The model is told confidence must reflect how often it expects to be overruled.
4. Gate: `confidence ≥ threshold` (config, default 0.80) → status `auto`; else `uncertain` → review queue.
5. Evidence: `receipt-matcher` runs for business items ≥ $75 lacking a receipt; a matched receipt raises confidence by 0.1, capped at 1.0, and clears `needs_receipt`.
6. User: review queue answers and digest undos write `source: user` labels; `set_merchant_rule` when the user says "always" or "never".

### Feedback and calibration

- Every user label is a calibration point: for each confidence bucket (0.5-0.6 … 0.9-1.0) track accuracy of auto and queued decisions against later user labels.
- Weekly job computes a reliability table; if the 0.80-0.90 bucket's accuracy drops below 0.85, raise `threshold` to 0.85 and alert.
- Threshold is per deployment in v1; per-user thresholds are backlog.
- Model choice for `categorizer` is a config string; the eval suite (Evals) decides between candidates on labeled data, not on vibes.

Mixed-use cards: `isBusiness` is decided per transaction, never per account; the intake answer "mostly business" only shifts the few-shot prior.

## Data model (SurrealDB)

One SurrealDB instance, two namespaces: `langgraph` (checkpoints and store, owned by `@surrealdb/langgraph`) and `taxxy` (app tables below). App tables are schemafull; every row carries `user`, `created_at`, `updated_at`.

| Table | Key fields | Notes |
| --- | --- | --- |
| `user` | `email`, `auth_provider_id`, `status` | No PII beyond email |
| `tax_profile` | `filing_status`, `state`, `business_description`, `naics`, `w2_wages`, `w2_withholding_expected`, `prior_year {total_tax, agi, confirmed}`, `se_health_premiums`, `sep_contribution`, `home_office`, `complete` | One per user; `patch` history in `audit_event` |
| `bank_item` | `plaid_item_id`, `access_token_enc`, `cursor`, `institution`, `status` | Token encrypted with KMS/libsodium, never returned to tools |
| `bank_account` | `bank_item`, `plaid_account_id`, `name`, `mask`, `type`, `mostly_business` | Last 4 digits only |
| `transaction` | `bank_account`, `plaid_txn_id`, `date`, `amount`, `description`, `merchant_key`, `plaid_pfc`, `counterparties`, `pending`, `removed` | Immutable except `removed`; raw Plaid JSON in `raw` |
| `categorization` | `transaction`, `label`, `is_business`, `confidence`, `source` (rule/llm/user), `status` (auto/uncertain/accepted), `rationale`, `model`, `rule_id`, `superseded_by` | Append-only; latest per transaction is current |
| `merchant_rule` | `merchant_key`, `label`, `is_business`, `condition?` | User-authored; mirrored to AGENTS.md |
| `payer` | `counterparty`, `is_income`, `confirmed_at`, `source` | Plaid `income_source` inferred rows start unconfirmed |
| `receipt` | `gmail_message_id`, `attachment_id`, `vendor`, `total`, `date`, `file_ref`, `transaction?`, `match_score` | Stored in object storage; row holds the pointer |
| `estimate` | `tax_year`, `quarter`, `input_snapshot` (JSON), `result` (JSON lines), `engine_version`, `constants_version`, `status` (draft/accepted/edited), `edits` (JSON) | The acceptance metric reads this table |
| `payment` | `estimate`, `amount`, `method` (manual/browser), `confirmation`, `paid_at` | v1: user-entered after paying on Direct Pay |
| `audit_event` | `actor` (user/agent/system), `action`, `target`, `before`, `after` | Every profile, rule, and estimate change |
| `eval_label` | `transaction`, `label`, `is_business`, `labeler`, `dataset` | Golden set rows, separate from live labels |

Relations use SurrealDB record links (`transaction.bank_account`); no graph edges in v1. Memory files (`AGENTS.md`, skills) live in the `langgraph` store under `["filesystem", userId]`.

## Integrations

Four external systems; each is wrapped in one TypeScript module with a sandbox/mock implementation so the agent runs end to end without live credentials.

| System | Products / scopes | How Taxxy uses it | Mock for dev and evals |
| --- | --- | --- | --- |
| Plaid | Link (web), Transactions (`/transactions/sync`), webhooks `SYNC_UPDATES_AVAILABLE` | Initial 24-month pull, then cursor sync on demand; Plaid categories and counterparties are features for the categorizer, not labels | Plaid Sandbox + fixture JSON per golden profile |
| Gmail | OAuth `gmail.readonly` only | Search queries `has:attachment (receipt OR invoice OR order)` within the installment period; prior-year 1040 search `filename:1040 OR subject:"tax return"`; attachments parsed by the LLM into `receipt` rows | Fixture mailbox JSON |
| SurrealDB | v3, self-hosted; `@surrealdb/langgraph` (`SurrealDBSaver`, `SurrealDBStore`) + app tables | Checkpoints, long-term memory, app data in one instance | Docker local instance |
| Langfuse | Cloud; LangChain `CallbackHandler`; datasets, scores, code and LLM-judge evaluators | Tracing and evals (next sections) | Separate `dev` project |

Plaid specifics: store `cursor` per item; treat `removed` and `modified` as supersessions that re-open categorization; pending transactions are shown but excluded from the engine until posted. Items in `ITEM_LOGIN_REQUIRED` block sync and surface a relink prompt.

Gmail specifics: never store message bodies; store only the extracted receipt fields and the attachment file. Token refresh handled server-side; scope expansion (send, modify) is forbidden by config.

Sources: [SurrealDB LangGraph integration](https://surrealdb.com/docs/build/integrations/ai-frameworks/langgraph) · [Plaid Enrich and counterparties](https://plaid.com/docs/api/products/enrich/) · [Langfuse LangChain/LangGraph integration](https://langfuse.com/resources/engineering/clarifications)

## Telemetry (Langfuse)

One Langfuse trace per user turn, one span per tool call and per subagent run, with the three product metrics emitted as scores so dashboards and evals read the same numbers.

| What | How |
| --- | --- |
| Handler | `CallbackHandler` passed in `config.callbacks` on every `agent.invoke`/`stream`; LangGraph nodes render in the agent graph view |
| Identity | `userId` (hashed), `sessionId` = thread id; tags `tax_year`, `quarter`, `agent` (orchestrator/categorizer/receipt-matcher), `env` |
| Metadata | `engineVersion`, `constantsVersion`, `categorizerModel`, `threshold`, `inputSnapshotId` on estimate spans |
| Scores (numeric, per trace or per object) | `uncategorized_rate`, `estimate_accepted` (1/0), `estimate_edited` (1/0), `edit_count`, `review_queue_size`, `auto_decisions`, `undo_count`, `calibration_bucket_accuracy` (weekly job) |
| Cost and latency | Default token and latency capture; alert at p95 turn latency > 15 s |
| Redaction | Mask `description` digits > 4, drop `raw` Plaid JSON and attachment bytes from traces; never log vault fields |

The engine never calls Langfuse itself; the `compute_quarterly_estimate` tool span carries its inputs and result.

## Evals

Three tiers gate every merge: engine golden tests (must be exact), categorization accuracy on real labeled data (threshold), and end-to-end trajectory runs on 20 contractor profiles scored in Langfuse (threshold plus human review).

### Metric definitions

| Metric | Definition | v1 target |
| --- | --- | --- |
| Uncategorized-transaction rate | Transactions in `uncertain` or `needs_receipt` status after one review session ÷ all transactions in the period | ≤ 10% before review; 0% after |
| Tax-calculation editing rate | Estimates with status `edited` ÷ estimates presented | ≤ 20% |
| Acceptance rate | Estimates with status `accepted` (zero edits) ÷ estimates presented | ≥ 70% |
| Auto-decision precision | Auto-applied labels later confirmed by the user ÷ auto-applied labels (by confidence bucket) | ≥ 0.90 in the 0.80-1.0 bucket |
| Engine exactness | Worksheet lines equal to oracle within $1 | 100% |

### Tier 1: engine golden tests

- Source: PolicyEngine US (hosted API or local `policyengine-us`) as oracle for income tax, SE tax, QBI; IRS Pub 505 and 1040-ES worked examples hand-entered; Form 2210 examples for safe-harbor edge cases.
- Cases: grid over net profit {5k, 25k, 60k, 120k, 190k, 260k} × prior-year {none, 100%, 110%} × withholding {0, 8k} × quarter {1-4}, plus edge cases (profit < $400, below $1,000 threshold, Q4 skip flag).
- Asserted in CI as unit tests; a constants change requires regenerating oracle values and a reviewed diff.

### Tier 2: categorization accuracy

- Dataset: `eval_label` rows from real donated statements and the externally gathered set (see the data-hunting brief), labeled against the taxonomy; stored as a Langfuse dataset with `transaction` as input and `{label, isBusiness}` as expected output. Minimum 2,000 rows across 20 contractors before a model is promoted.
- Runs: every candidate `categorizer` model and prompt version against the full dataset; report precision/recall per label, business-vs-personal F1, confidence calibration curve (ECE).
- Gate: business-vs-personal F1 ≥ 0.92 and ECE ≤ 0.05; otherwise the threshold is raised, not the gate lowered.

### Tier 3: end-to-end profiles

- 20 contractor profiles, each a fixture: Plaid sandbox transactions (real donated data where available), Gmail fixture mailbox, intake answers, expected worksheet from Tier 1 oracle, and expected review-queue contents.
- Run the full agent headlessly per profile per quarter; Langfuse code evaluators check: estimate equals oracle, review queue contains exactly the ambiguous items, no dollar figure in assistant text absent from the engine result, no SSN/account pattern in any trace, turn count ≤ budget.
- LLM-judge evaluators (rubric, 1-5): explanation correctness of the safe-harbor choice, clarity of the worksheet narration. Score < 4 on correctness fails the run.
- Human review: weekly annotation queue of 20 random production traces scored on the same rubric; disagreement with the judge > 1 point triggers rubric revision.

### Profile matrix (20)

| Dimension | Values covered |
| --- | --- |
| Income level | 3 under $30k, 8 at $30-100k, 6 at $100-200k, 3 over $200k |
| Card mixing | 6 fully separate, 10 mixed, 4 single card for everything |
| Payers | 1, 2-3, 5+ counterparties; one with platform payouts (Stripe/PayPal) |
| W-2 overlap | 5 profiles with a W-2 job and withholding |
| Prior year | 6 with none, 10 at 100%, 4 at 110% |
| Receipts | 8 with Gmail receipts, 12 without |
| Edge | 1 below $400 profit, 1 below $1,000 threshold, 1 Q4-only income spike |

CI: Tier 1 on every commit; Tier 2 and 3 nightly and on any prompt, model, threshold or constants change. Results post to Langfuse experiments with the git SHA as run name.

## Security and privacy

The model never sees SSNs, full account numbers, or OAuth tokens; those live in a vault and are filled into forms or API calls by code the model only triggers.

| Area | Rule |
| --- | --- |
| Vault | Plaid access tokens, Gmail refresh tokens, and (backlog) Direct Pay identity fields encrypted at rest with a KMS or libsodium key held outside the DB; tools reference them by `vaultRef` |
| Model context | Tool results are scrubbed: account `mask` only, no `raw` Plaid JSON, no attachment bytes; a regex guard rejects any tool output containing a 9-digit SSN or 10-17 digit account pattern |
| Auth | Web app auth via a managed provider (Clerk/Auth0 class); `userId` comes from the session into LangGraph `configurable`, never from the model |
| Tenancy | Every SurrealDB query filters on `user`; store namespaces are keyed by `userId`; subagents receive only the parent's user context |
| Retention | Transactions kept while the bank item is linked plus 7 years for accepted estimates; receipts deleted with the user; traces in Langfuse 90 days, redacted |
| Audit | `audit_event` for every profile, rule, estimate, and payment change, with actor = user/agent/system |
| Prompt injection | Transaction descriptions, email bodies, and receipt text are data; the categorizer prompt wraps them in delimiters and the orchestrator is instructed to ignore instructions found there; a Tier 3 test injects "ignore previous instructions" into a description |
| Disclaimers | Every estimate carries "estimate, not tax advice" and the engine/constants version; the app is not an e-file provider |

## Hosting and deployment (DigitalOcean)

One DigitalOcean Droplet (4 vCPU / 8 GB, Ubuntu) runs Docker Compose; Langfuse stays on Langfuse Cloud. This is the simplest setup that keeps SurrealDB self-hosted and leaves room for a browser container later.

| Service | Image / runtime | Notes |
| --- | --- | --- |
| `web` | Next.js (or similar) | Auth, Plaid Link, chat UI streaming from the agent |
| `agent` | Node 22, LangGraph.js server (`langgraph-cli` dev server or a thin Hono/Express wrapper around `agent.stream`) | Exposes `/threads/{id}/runs`; one container, scale later |
| `surrealdb` | `surrealdb/surrealdb:v3` | Volume-backed; nightly `SURREAL export` to DO Spaces |
| `worker` | Node 22 | Webhook receiver (Plaid), calibration job, eval runner |
| `browser` (backlog) | Playwright image | Only when `payment-executor` ships |
| Storage | DO Spaces (S3-compatible) | Receipts, 1040 PDFs, DB backups |
| Edge | Caddy or DO Load Balancer | TLS, single domain |

Environment (secrets via DO's encrypted env or a `.env` outside the repo): `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `SURREAL_URL/NS/DB/USER/PASS`, `LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL`, `LLM_API_KEY` (orchestrator), `CATEGORIZER_MODEL`, `CATEGORIZER_THRESHOLD`, `VAULT_KEY`, `SPACES_*`.

CI: GitHub Actions runs Tier 1 on PR, builds images, deploys on merge to `main` via SSH + `docker compose up -d`; nightly job runs Tier 2 and 3. DO App Platform is the alternative if the Droplet becomes a chore; nothing in the design depends on either.

## Backlog (priority order)

| # | Item | Why it waits | Design hook already in v1 |
| --- | --- | --- | --- |
| 1 | Browser payment on IRS Direct Pay (`payment-executor`) | IRS bot defenses, identity data handling, legal review | Subagent registered, `interruptOn.submit_payment`, vault refs, `payment` table |
| 2 | Proactive mode: weekly sync, T-14 and T-3 deadline nudges, email digest | Needs a scheduler and notification channel | `worker` service, Plaid webhooks, `estimate.status` |
| 3 | State estimates, New York first (IT-2105) plus NYC UBT check | Different dates, safe harbors, conformity | `tax_profile.state` stored; engine takes a `jurisdictions[]` list |
| 4 | MFJ, dependents, credits | Spouse withholding materially changes the number | `filing_status` enum already wider than single |
| 5 | Annualized income method (Form 2210 Sch. AI) | Only helps uneven earners; adds worksheet complexity | Engine `projectionMethod` extensible |
| 6 | Annual filing (Schedule C, SE, 1040) | Separate product surface and e-file provider status | Categorization and profile data are reusable |
| 7 | Small fine-tuned classifier for `categorizer` | Needs \~2,000+ user labels | `categorization.source/model`, Tier 2 harness |
| 8 | Per-user confidence thresholds | Needs enough labels per user | Threshold is already a config value |
| 9 | Invoice/accounting integrations (Stripe, QuickBooks) | Not needed for bank-first v1 | `payer` table, `receipt` pointer model |
| 10 | PolicyEngine sidecar at runtime | Only if state work outgrows the thin engine | Oracle already wired in Tier 1 |

## Devin build plan

Seven milestones, each a mergeable PR with its own acceptance test; M1 and M2 can run in parallel, everything else is sequential. Repo: monorepo (`apps/web`, `apps/agent`, `packages/engine`, `packages/integrations`, `packages/evals`), pnpm, TypeScript strict, Vitest.

| Milestone | Scope | Accepted when |
| --- | --- | --- |
| M0 Scaffold | Monorepo, Docker Compose (agent, surrealdb, web stub), Langfuse handler wired, CI running Tier 1 placeholder | `docker compose up` serves a hello-world agent turn that appears as a trace in Langfuse |
| M1 Tax engine | `@taxxy/engine`, `constants/2026.ts`, worksheet lines, safe-harbor logic, `EstimateResult` | Tier 1 golden tests pass against PolicyEngine oracle values and Pub 505 examples; determinism test passes |
| M2 Data layer | SurrealDB schema (all tables), `@surrealdb/langgraph` checkpointer + store, vault module, audit events | Schema migration script; store round-trips `AGENTS.md`; tenancy test fails cross-user reads |
| M3 Plaid + categorizer | Link flow, `/transactions/sync`, webhook receiver, normalization, rules, `categorizer` subagent with structured output, threshold gate, review queue tool | Sandbox item syncs 24 months; Tier 2 harness runs on fixture labels and reports F1 and ECE |
| M4 Orchestrator | `createDeepAgent` config, skills (`profile-intake`, `quarterly-estimate`, `review-queue`, `explain-worksheet`), all tool contracts, memory writes, interrupts | A scripted conversation (fixture profile) completes intake, review, and an accepted estimate headlessly; no dollar figure outside engine output (asserted) |
| M5 Gmail + prior-year | OAuth read-only, receipt search and extraction, `receipt-matcher` subagent, 1040 PDF extraction with confirm step | Fixture mailbox yields matched receipts; prior-year numbers extracted and confirmed in one turn |
| M6 Evals + hardening | 20 profile fixtures, Tier 3 runner, Langfuse datasets/experiments/judges, injection test, redaction guard, nightly CI | All 20 profiles pass Tier 3 gates; acceptance ≥ 70% on scripted "reasonable user" runs; prompt-injection test passes |

Devin working agreements:

- One PR per milestone; PR description lists which spec sections it implements and any deviation, with reason.
- Any change to constants, thresholds, prompts, or model strings must include the eval run link.
- Never write a tax number in prose or prompt; the engine is the only source.
- Unknowns go in the Decisions section of this doc as a question, not into code as a guess.

## Decisions and open questions

Decided in planning (Oct 19, 2026):

- Rename: Finch → Taxxy; sole proprietors with 1099 income only; federal only; annual filing out.
- Stack: TypeScript, deepagents.js, one frontier model for the orchestrator, cheaper model for the categorizer; SurrealDB for checkpoints, store, and app data; Langfuse Cloud for telemetry and evals; DigitalOcean Droplet with Docker Compose.
- Tax math: own deterministic engine with hard-coded versioned constants; PolicyEngine US as the test oracle, not a runtime dependency.
- Categorization: rules → LLM → user; auto-decide at confidence ≥ 0.80, lower goes to the user; threshold recalibrated from user labels.
- Income: inferred from Plaid counterparties, confirmed and remembered per payer.
- Safe harbor default: prior year (100%/110%); current-year 90% when no prior year.
- Prior-year 1040: optional, PDF upload or Gmail pull, two numbers confirmed by the user.
- Payments: v1 shows Direct Pay instructions; browser submission is backlog #1 with vault and interrupt reserved now.
- Golden data: real labeled data from donated statements and an external gathering agent; no synthetic transactions in the eval set.

Open questions:

- [ ] Which frontier model string for the orchestrator, and which cheaper model for `categorizer` (decided by Tier 2 results)?
- [ ] Who donates and labels the first real statements, and under what consent language?
- [ ] Auth provider for the web app (Clerk, Auth0, or Supabase Auth)?
- [ ] Plaid production access timeline; sandbox-only until then?
- [ ] Gmail OAuth verification: a `gmail.readonly` scope needs Google's restricted-scope review before non-test users can connect.
- [ ] Do we show the "decided for you" digest every session or only when it has new items?

Things I decided for you in this spec:

- Default projection method is linear annualization of YTD net profit.
- Receipts are required for business items ≥ $75 (IRS substantiation rule of thumb), not for every item.
- Meals are flagged at 50% deductible by the engine; the user is not asked per meal.
- `v1 done` target is 70% acceptance on golden profiles.
- 24 months of Plaid history on first link.
- Trace retention 90 days, estimate retention 7 years.
- Monorepo with pnpm and Vitest.
- Droplet size 4 vCPU / 8 GB.
