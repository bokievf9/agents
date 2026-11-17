# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/lead-intake/Dockerfile -t lead-intake .
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain only as a fallback if better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/lead-intake/package.json apps/lead-intake/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY apps/lead-intake apps/lead-intake
RUN pnpm --filter @fir/core build \
    && pnpm --filter lead-intake build \
    && pnpm --filter lead-intake --prod deploy /out \
    && node -e "new (require('/out/node_modules/better-sqlite3'))(':memory:').exec('select 1')"

FROM node:22-bookworm-slim
LABEL app=lead-intake
ENV NODE_ENV=production HOME=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
USER node
EXPOSE 8787
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
