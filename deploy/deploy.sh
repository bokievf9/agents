#!/usr/bin/env bash
# Forced command for the deploy SSH key (see bootstrap-vps.sh). Whatever the client asks to run is ignored.
# stdin: line 1 = GHCR user, line 2 = GHCR token (short-lived). compose.yaml is NOT accepted from the
# client: it is root-owned on the VPS, because docker-group access plus a client-supplied compose file
# would be root for whoever holds the key.
set -euo pipefail
cd /opt/fir-agents

read -r ghcr_user
read -r ghcr_token
[[ -n "$ghcr_user" && -n "$ghcr_token" ]] || { echo "missing registry credentials" >&2; exit 1; }
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

printf '%s' "$ghcr_token" | docker login ghcr.io -u "$ghcr_user" --password-stdin >/dev/null
# fir-llm is an external network created by bootstrap; this is a no-op when it exists.
docker network inspect fir-llm >/dev/null 2>&1 || docker network create fir-llm >/dev/null
docker compose pull
docker compose up -d --remove-orphans
# every image of ours (hq, renderer with Chromium and Piper, polly) leaves dangling layers with each push
for app in hq renderer polly; do docker image prune -f --filter "label=app=$app" >/dev/null; done
docker compose ps
