#!/usr/bin/env bash
# Nightly Postgres dump, keeps 7 days. Run from the repo dir on the VM, e.g. cron:
#   0 3 * * * cd ~/spotibay && TAG=$(cut -d= -f2 .tag) scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
out="${BACKUP_DIR:-backups}"
mkdir -p "$out"
docker compose -f docker-compose.vm.yml exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$out/spotibay-$(date +%F).sql.gz"
find "$out" -name 'spotibay-*.sql.gz' -mtime +7 -delete
