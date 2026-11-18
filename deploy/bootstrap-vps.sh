#!/usr/bin/env bash
# One-time setup of the isolated Fir agents runtime on the Vibely VPS. Run as root (or via sudo) on the VPS:
#   sudo bash bootstrap-vps.sh "<deploy public key line>"
# It touches only: the new user `agents`, /opt/fir-agents, and (if missing) the docker packages.
# It does NOT touch /var/www/vibely, the `deploy` user, pm2, nginx, the firewall or any existing key.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
PUBKEY="${1:?usage: bootstrap-vps.sh \"ssh-ed25519 AAAA... comment\"}"
[[ "$PUBKEY" == ssh-ed25519\ * ]] || { echo "expected an ssh-ed25519 public key" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v docker >/dev/null; then
  apt-get update && apt-get install -y docker.io docker-compose-v2
fi
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 plugin is missing; install it and re-run" >&2; exit 1; }
systemctl enable --now docker   # containers come back after reboot (restart: unless-stopped)
# Shared LLM network: OmniRoute joins it, Dono (separate compose project) reaches http://omniroute:20128 through it.
docker network inspect fir-llm >/dev/null 2>&1 || docker network create fir-llm

if ! id agents >/dev/null 2>&1; then
  useradd --home-dir /opt/fir-agents --create-home --shell /bin/bash --comment "Fir agents runtime" agents
fi
passwd -l agents >/dev/null
usermod -aG docker agents         # needed for `docker compose`; the key below is locked to one command
gpasswd -d agents sudo 2>/dev/null || true
AGENTS_UID="$(id -u agents)"; AGENTS_GID="$(id -g agents)"

# Writable by agents: only data. Everything that decides what runs (compose, deploy script, authorized_keys)
# is root-owned, so neither the container nor a process running as agents can widen its own access.
install -d -o agents -g agents -m 700 /opt/fir-agents /opt/fir-agents/data /opt/fir-agents/data/polly /opt/fir-agents/data/hq /opt/fir-agents/data/omniroute
install -d -o root -g root -m 755 /opt/fir-agents/bin /opt/fir-agents/.ssh
install -o root -g root -m 755 "$HERE/deploy.sh" /opt/fir-agents/bin/deploy.sh
sed -e "s/__AGENTS_UID__/$AGENTS_UID/" -e "s/__AGENTS_GID__/$AGENTS_GID/" "$HERE/../compose.yaml" > /opt/fir-agents/compose.yaml
chown root:root /opt/fir-agents/compose.yaml && chmod 644 /opt/fir-agents/compose.yaml

# The key can only run deploy.sh: no shell, no pty, no forwarding, no other command.
echo "command=\"/opt/fir-agents/bin/deploy.sh\",restrict $PUBKEY" > /opt/fir-agents/.ssh/authorized_keys
chown root:root /opt/fir-agents/.ssh/authorized_keys && chmod 644 /opt/fir-agents/.ssh/authorized_keys

if [[ ! -f /opt/fir-agents/omniroute.env ]]; then
  install -o agents -g agents -m 600 /dev/null /opt/fir-agents/omniroute.env
  echo "Created empty /opt/fir-agents/omniroute.env (OmniRoute secrets: JWT_SECRET, API_KEY_SECRET, INITIAL_PASSWORD...): fill it in."
fi
if [[ ! -f /opt/fir-agents/.env ]]; then
  install -o agents -g agents -m 600 /dev/null /opt/fir-agents/.env
  echo "Created empty /opt/fir-agents/.env: copy the real one in (scp), then chown agents:agents and chmod 600."
fi
# Compose expands $ in env files: single-quote any secret that contains a dollar sign.

echo "Done. agents uid=$AGENTS_UID. Next: put the production .env at /opt/fir-agents/.env, then push to main."
