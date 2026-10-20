# Taxxy

Quarterly estimated tax agent for US sole proprietors. Build spec: docs/SPEC.md.

## Run locally

```sh
surreal start --user root --pass root --bind 127.0.0.1:8000 surrealkv:./data/taxxy.kv   # or: docker compose -f infra/compose.yaml up surrealdb
cp .env.example .env            # set ANTHROPIC_API_KEY (or LLM_API_KEY), VAULT_KEY, SESSION_SECRET
pnpm install
pnpm --filter @taxxy/agent dev  # agent API on :8787 (Plaid + Gmail in fixture mode by default)
pnpm --filter @taxxy/web dev    # web app on :3000 — create an account, link the fixture bank, chat
```

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (SurrealDB-backed tests skip when no DB is reachable), `pnpm test:tier1`, `pnpm --filter @taxxy/evals tier2`, `pnpm --filter @taxxy/agent tier3`.

Layout: `packages/engine` (pure tax math), `packages/db` (SurrealDB schema, tenancy, vault), `packages/integrations` (Plaid, Gmail, categorizer, redaction), `packages/evals` (Tier 2/3 fixtures, Langfuse), `apps/agent` (deep agent + HTTP API), `apps/web` (account, bank link, chat).

## Langfuse

Agents and humans working on tracing, datasets, experiments, evaluators or prompts follow the vendored [Langfuse agent skill](.agents/skills/langfuse/SKILL.md) (docs first, `npx langfuse-cli` for data, audit real traces).

- Tracing: `apps/agent/src/telemetry.ts` — one trace per turn (`taxxy-turn`), `sessionId` = thread `{userId}:{taxYear}:{quarter}`, hashed `userId`, tags `tax_year:* quarter:* agent:* env:*`, metadata (app/engine/model versions), masking via `maskDeep`. Enabled when `LANGFUSE_*` keys are set.
- Outcome scores (`apps/agent/src/scores.ts`): `estimate_accepted`, `estimate_edited`, `review_label_overridden` on the thread session.
- Dataset: `pnpm --filter @taxxy/evals sync-datasets` pushes the 20 Tier 3 profiles to `taxxy-tier3-profiles`.
- Experiment gate: `apps/agent/experiments/tier3-gate.ts` (contract of `langfuse/experiment-action`; `RegressionError` when pass rate < 100% or acceptance < 70%); run locally with `pnpm --filter @taxxy/agent tier3:experiment`, nightly/PR via `.github/workflows/nightly.yml`.
