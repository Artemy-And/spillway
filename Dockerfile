# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# Build the admin UI (it type-checks against the server's API types).
FROM base AS web
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm --filter @gatehouse/web build

# Production dependencies of the server only.
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @gatehouse/server

FROM node:24-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 PUBLIC_DIR=/app/apps/server/public
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY apps/server/package.json apps/server/
COPY apps/server/drizzle apps/server/drizzle
COPY apps/server/src apps/server/src
COPY --from=web /app/apps/web/dist apps/server/public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# Node 24 runs the TypeScript sources directly; there is no build step for the server.
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/index.ts"]
