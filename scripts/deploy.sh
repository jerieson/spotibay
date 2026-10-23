#!/usr/bin/env bash
# Build the images here and load them on the VM, so the VM never builds anything.
# Usage: scripts/deploy.sh <ssh-host> [remote-dir]
#   ssh-host   a Host from ~/.ssh/config (e.g. one using `ProxyCommand cloudflared access ssh ...`)
#   remote-dir clone of this repo on the VM, holding .env (default: ~/spotibay)
set -euo pipefail

host="${1:?usage: scripts/deploy.sh <ssh-host> [remote-dir]}"
dir="${2:-spotibay}"
cd "$(dirname "$0")/.."

tag="$(git rev-parse --short HEAD)"
docker build -f apps/api/Dockerfile -t "spotibay-api:$tag" .
docker build -f apps/web/Dockerfile -t "spotibay-web:$tag" .

echo "Sending images ($tag) to $host..."
docker save "spotibay-api:$tag" "spotibay-web:$tag" | gzip | ssh "$host" 'gunzip | docker load'

ssh "$host" "cd $dir && git pull --ff-only && TAG=$tag docker compose -f docker-compose.vm.yml up -d && echo TAG=$tag > .tag && docker image prune -f"
echo "Deployed $tag"
