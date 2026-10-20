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
