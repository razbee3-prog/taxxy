FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @taxxy/web...
EXPOSE 3000
CMD ["pnpm", "--filter", "@taxxy/web", "start"]
