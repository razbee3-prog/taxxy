# Agent instructions for Taxxy

- Spec: `docs/SPEC.md`. One PR per milestone; list the spec sections covered and any deviations.
- Checks before pushing: `pnpm lint`, `pnpm typecheck`, `pnpm test` (SurrealDB-backed tests need a local `surreal start`; see README).
- Tax math lives only in `@taxxy/engine`; nothing else computes dollar figures.
- `userId` comes from the web session → LangGraph `configurable.user_id`; tools never accept it from the model.
- **Langfuse (tracing, datasets, experiments, evaluators, scores, prompt management): follow the vendored skill in `.agents/skills/langfuse/SKILL.md`** — fetch current docs first, use `langfuse-cli` for data, audit real traces after instrumenting. Keys are `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL`; never paste them into chat or commits.
