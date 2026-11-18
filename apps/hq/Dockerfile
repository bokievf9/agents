# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/hq/Dockerfile -t hq .
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain only as a fallback if better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/hq/package.json packages/hq/
COPY packages/workers/content-maker/package.json packages/workers/content-maker/
COPY packages/workers/monitoring/package.json packages/workers/monitoring/
COPY packages/workers/finance/package.json packages/workers/finance/
COPY packages/workers/lead-intake/package.json packages/workers/lead-intake/
COPY packages/workers/prospector/package.json packages/workers/prospector/
COPY packages/workers/trend-scout/package.json packages/workers/trend-scout/
COPY packages/workers/publisher/package.json packages/workers/publisher/
COPY packages/workers/seo/package.json packages/workers/seo/
COPY packages/workers/analyst/package.json packages/workers/analyst/
COPY apps/hq/package.json apps/hq/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY packages/hq packages/hq
COPY packages/workers packages/workers
COPY apps/hq apps/hq
RUN pnpm --filter "hq..." build \
    && pnpm --filter hq --prod deploy /out \
    && node -e "new (require('/out/node_modules/better-sqlite3'))(':memory:').exec('select 1')"

FROM node:22-bookworm-slim
LABEL app=hq
ENV NODE_ENV=production HOME=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
COPY --from=build /app/apps/hq/instructions ./instructions
USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
