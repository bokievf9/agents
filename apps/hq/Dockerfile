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
COPY packages/workers/presales/package.json packages/workers/presales/
COPY packages/workers/referral/package.json packages/workers/referral/
COPY packages/workers/trend-scout/package.json packages/workers/trend-scout/
COPY packages/workers/publisher/package.json packages/workers/publisher/
COPY packages/workers/seo/package.json packages/workers/seo/
COPY packages/workers/analyst/package.json packages/workers/analyst/
COPY packages/workers/customer-support/package.json packages/workers/customer-support/
COPY packages/workers/billing/package.json packages/workers/billing/
COPY packages/workers/onboarding/package.json packages/workers/onboarding/
COPY packages/workers/project-manager/package.json packages/workers/project-manager/
COPY packages/workers/reviewer/package.json packages/workers/reviewer/
COPY packages/workers/deployer/package.json packages/workers/deployer/
COPY packages/workers/documents/package.json packages/workers/documents/
COPY packages/workers/knowledge/package.json packages/workers/knowledge/
COPY apps/hq/package.json apps/hq/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY packages/hq packages/hq
COPY packages/workers packages/workers
COPY apps/hq apps/hq
COPY knowledge knowledge
RUN pnpm --filter "hq..." build \
    && pnpm --filter hq --prod deploy /out \
    && node -e "new (require('/out/node_modules/better-sqlite3'))(':memory:').exec('select 1')" \
    && test -f /out/node_modules/@fir/core/assets/fonts/onest-latin-400-normal.woff \
    && test -f /out/node_modules/@fir/core/assets/fonts/onest-cyrillic-700-normal.woff \
    && test -f /out/node_modules/@fir/core/assets/fonts/onest-cyrillic-ext-700-normal.woff

FROM node:22-bookworm-slim
LABEL app=hq
ENV NODE_ENV=production HOME=/tmp KNOWLEDGE_DIR=/app/knowledge
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini age tar \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
COPY --from=build /app/apps/hq/instructions ./instructions
COPY --from=build /app/knowledge ./knowledge
USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
