# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/prospector/Dockerfile -t prospector .
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain only as a fallback if better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/prospector/package.json apps/prospector/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY apps/prospector apps/prospector
RUN pnpm --filter @fir/core build \
    && pnpm --filter prospector build \
    && pnpm --filter prospector --prod deploy /out \
    && node -e "new (require('/out/node_modules/better-sqlite3'))(':memory:').exec('select 1')"

FROM node:22-bookworm-slim
LABEL app=prospector
ENV NODE_ENV=production HOME=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
COPY --from=build /app/apps/prospector/prompts ./prompts
USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
