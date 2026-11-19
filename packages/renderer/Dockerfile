# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f packages/renderer/Dockerfile -t renderer .
# Everything the renderer needs is baked in: the Chromium headless shell, the Piper voice, the fonts. Nothing is
# downloaded when the container starts (compose runs it with network_mode: none).
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
COPY packages/renderer/package.json packages/renderer/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY packages/hq packages/hq
COPY packages/workers/content-maker packages/workers/content-maker
COPY packages/renderer packages/renderer
RUN pnpm --filter "renderer..." build \
    && pnpm --filter renderer --prod deploy /out \
    && node -e "new (require('/out/node_modules/better-sqlite3'))(':memory:').exec('select 1')"

FROM node:22-bookworm-slim
LABEL app=renderer
ENV NODE_ENV=production HOME=/tmp PYTHONDONTWRITEBYTECODE=1 \
    PIPER_BIN=/opt/piper-venv/bin/piper PIPER_VOICES_DIR=/opt/piper/voices PIPER_VOICE=ru_RU-denis-medium
# Libraries the Chromium headless shell needs (Remotion docs, Debian), tini, python3 for Piper.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini python3 python3-venv \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 \
      libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
    && rm -rf /var/lib/apt/lists/*

# Piper TTS 1.8.0 (GPL-3.0, run as a separate process) with every wheel pinned by hash.
COPY packages/renderer/docker/piper-requirements.txt /tmp/piper-requirements.txt
RUN python3 -m venv /opt/piper-venv \
    && /opt/piper-venv/bin/pip install --no-cache-dir --require-hashes --no-deps -r /tmp/piper-requirements.txt \
    && rm /tmp/piper-requirements.txt

# Voice ru_RU-denis-medium: rhasspy/piper-voices pinned to one commit, files checked by sha256. Dataset licence CC0.
ARG VOICES_REV=04ca88f5685ca5253c701af3687e155b113bd512
RUN mkdir -p /opt/piper/voices && cd /opt/piper/voices \
    && curl -fsSL -o ru_RU-denis-medium.onnx "https://huggingface.co/rhasspy/piper-voices/resolve/${VOICES_REV}/ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx" \
    && curl -fsSL -o ru_RU-denis-medium.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/${VOICES_REV}/ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx.json" \
    && printf '%s  %s\n' \
         879bc365cb14d1380e3f5ed6044162ccf54c99f6161871569b7f830aec3ce841 ru_RU-denis-medium.onnx \
         5891b94580ae739a8cdc5d17591db6800333f85164d13599aca893883d99b9eb ru_RU-denis-medium.onnx.json \
       | sha256sum -c - \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
# The browser goes to /app/node_modules/.remotion (Remotion looks it up from the working directory's package.json).
RUN node -e "import('@remotion/renderer').then((m) => m.ensureBrowser()).then(() => console.log('chrome ready'))" \
    && test -d node_modules/.remotion/chrome-headless-shell \
    && /opt/piper-venv/bin/piper --help >/dev/null
USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
