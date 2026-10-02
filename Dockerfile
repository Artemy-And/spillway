# syntax=docker/dockerfile:1

# The base image is pinned by digest, in both FROM lines, so a signed release can be rebuilt as
# it was; Dependabot keeps the digest current.

# Stages that run commands use the build machine's own platform. The server's dependencies are
# plain JavaScript (SQLite is built into Node), so the same files serve amd64 and arm64 and the
# arm64 image needs no emulation. A dependency with native code would break that: it would have
# to be installed in the final stage instead.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
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
RUN pnpm --filter @spillway/web build

# Production dependencies of the server only, and the data directory the volume mounts on.
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @spillway/server && mkdir /data

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 PUBLIC_DIR=/app/apps/server/public
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps --chown=node:node /data /data
COPY apps/server/package.json apps/server/
COPY apps/server/drizzle apps/server/drizzle
COPY apps/server/src apps/server/src
COPY --from=web /app/apps/web/dist apps/server/public
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# Node 24 runs the TypeScript sources directly; there is no build step for the server.
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/index.ts"]
