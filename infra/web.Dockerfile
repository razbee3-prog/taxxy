FROM node:22-slim
WORKDIR /app
COPY apps/web ./apps/web
EXPOSE 3000
CMD ["node", "apps/web/server.mjs"]
