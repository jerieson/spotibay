# Spotibay

Self-hosted rooms where people listen to YouTube music in sync. See `PLAN.md` for the build plan and `CLAUDE.md` for dev commands.

## Deploy on a small VM behind a Cloudflare tunnel

Images are built on your dev machine and loaded on the VM, so the VM needs no node, pnpm or build cache.
It only needs Docker with Compose v2 and about 1 GB of free disk.

1. **Swap** (2 GB VMs): `free -h`. If there is none:
   `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab`
2. **Clone** (public repo, no credentials): `git clone https://github.com/jerieson/spotibay.git ~/spotibay`. It is used for `docker-compose.vm.yml`, `caddy/` and `scripts/`. It does not interfere with other clones (e.g. from GitLab); Compose prefixes everything with `spotibay_`.
3. **`~/spotibay/.env`** from `.env.example`:
   - `HTTP_PORT=8083` (any free port)
   - `HTTP_BIND`: `127.0.0.1` if cloudflared runs on the host. If cloudflared runs in a container, use the docker bridge address (`172.17.0.1`; check with `ip -4 addr show docker0`), which is not reachable from outside the VM.
   - `APP_URL=https://<your tunnel hostname>`
   - `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
   - `JWT_SECRET`, `RECOVERY_HMAC_SECRET`: `openssl rand -base64 32`
   - `YOUTUBE_API_KEY`
   - `ADMIN_PASSWORD_HASH`: on your dev machine run `pnpm --filter api hash-password '<password>'` and paste the result in single quotes.
4. **Tunnel**: add a public hostname to your cloudflared tunnel pointing at `http://localhost:8083` (cloudflared on the host) or `http://172.17.0.1:8083` (cloudflared in a container on the default bridge). `docker inspect cloudflared --format '{{.HostConfig.NetworkMode}}'` shows `host`, `default` or a network name.
5. **Deploy** from the dev machine: `scripts/deploy.sh <ssh-host>`. It builds both images, streams them over SSH (`docker save | gzip | ssh | docker load`), pulls the repo, runs `docker compose -f docker-compose.vm.yml up -d` and prunes old images. Use an SSH host alias with `ProxyCommand cloudflared access ssh --hostname <ssh hostname>` if the VM is only reachable through Cloudflare Access.
6. **Check**: `docker compose -f docker-compose.vm.yml ps`, open the URL, then `docker stats --no-stream` for memory.

Update = run `scripts/deploy.sh` again. Migrations run when the api container starts.
Caddy forwards the real visitor IP (`CF-Connecting-IP`) to the api, which IP bans rely on.

## Backups

`scripts/backup.sh` writes `backups/spotibay-YYYY-MM-DD.sql.gz` and keeps 7 days. Nightly cron on the VM:

```
0 3 * * * cd ~/spotibay && TAG=$(cut -d= -f2 .tag) scripts/backup.sh
```

### Restore

```
cd ~/spotibay && set -a && . ./.env && set +a
export TAG=$(cut -d= -f2 .tag)
docker compose -f docker-compose.vm.yml stop api
docker compose -f docker-compose.vm.yml exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE $POSTGRES_DB" -c "CREATE DATABASE $POSTGRES_DB"
gunzip -c backups/spotibay-YYYY-MM-DD.sql.gz | docker compose -f docker-compose.vm.yml exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
docker compose -f docker-compose.vm.yml start api
```

## Own domain with Caddy HTTPS

Use `docker-compose.yml` instead (`DOMAIN` in `.env`, ports 80/443 free): it builds on the host.
