FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@12.8.1 --activate
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/agent/package.json apps/agent/
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @taxxy/agent...
COPY apps/agent ./apps/agent
EXPOSE 8787
CMD ["pnpm", "--filter", "@taxxy/agent", "exec", "tsx", "src/server.ts"]
