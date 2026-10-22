# Spotibay Build Plan

## How to use this with Claude Code

1. Create an empty folder, put `CLAUDE.md` and `PLAN.md` in it, run `git init`, then start `claude` in that folder.
2. Run one phase per session. Start each session in plan mode (Shift+Tab) and paste the phase's prompt.
3. Review the plan Claude Code proposes, approve it, let it build, then run the "Done when" checks yourself.
4. Commit after each phase: `git commit -am "phase N: <name>"`.
5. Run `/clear` before starting the next phase so the context stays small.

Prerequisites on your machine: Node.js LTS, pnpm, Docker Desktop (or Docker Engine + Compose), a Google Cloud project with **YouTube Data API v3** enabled and an API key.

---

## Architecture summary

```
Browser (React SPA + YouTube IFrame player)
   │  HTTPS + WebSocket
   ▼
Caddy (TLS, serves /, proxies /api and /socket.io)
   ▼
api (Express + Socket.IO)
   ├── PostgreSQL (persistent data)
   └── Redis (live room state, presence, cache, rate limits)
   └── YouTube Data API v3 (search, video details, playlist import)
```

No audio passes through the server. Each browser plays YouTube directly; the server only sends sync state.

### Repository layout

```
.
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── index.ts              # bootstrap: env, db, redis, http, socket
│   │   │   ├── env.ts                # Zod-validated env
│   │   │   ├── db/schema.ts          # Drizzle schema
│   │   │   ├── db/client.ts
│   │   │   ├── redis.ts
│   │   │   ├── routes/               # REST routers
│   │   │   ├── socket/               # socket handlers by domain
│   │   │   ├── services/             # settings, youtube, rooms, queue, playback, auth, moderation
│   │   │   ├── middleware/           # auth, rate limit, error handler
│   │   │   └── scripts/hash-password.ts
│   │   ├── drizzle/                  # generated migrations
│   │   ├── test/
│   │   └── Dockerfile
│   └── web/
│       ├── src/
│       │   ├── main.tsx
│       │   ├── routes/               # pages
│       │   ├── components/           # app components
│       │   ├── components/ui/        # shadcn
│       │   ├── features/             # room, player, queue, search, playlists, chat, profile, admin
│       │   ├── lib/                  # api client, socket client, time sync
│       │   └── stores/               # Zustand stores
│       └── index.html
├── packages/shared/src/
│   ├── schemas/                      # Zod schemas
│   ├── socket-events.ts              # typed ServerToClient / ClientToServer maps
│   ├── settings.ts                   # settings keys, types, defaults
│   └── index.ts
├── caddy/Caddyfile
├── docker-compose.yml                # production
├── docker-compose.dev.yml            # dev: postgres + redis only
├── .env.example
├── CLAUDE.md
└── PLAN.md
```

### Environment variables (`.env.example`)

```
NODE_ENV=production
DOMAIN=spotibay.example.com
APP_URL=https://spotibay.example.com

DATABASE_URL=postgres://spotibay:change_me@postgres:5432/spotibay
POSTGRES_USER=spotibay
POSTGRES_PASSWORD=change_me
POSTGRES_DB=spotibay

REDIS_URL=redis://redis:6379

YOUTUBE_API_KEY=

JWT_SECRET=                 # 32+ random bytes, base64
RECOVERY_HMAC_SECRET=       # 32+ random bytes, base64

ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=        # from: pnpm --filter api hash-password <password>
```

### Database schema (Drizzle)

| Table | Columns |
|---|---|
| `users` | `id` uuid pk, `display_name` text, `avatar` jsonb (`{style, seed, options}`), `recovery_code_hash` text unique, `created_at`, `last_seen_at`, `banned_until` timestamptz null |
| `admins` | `id` uuid pk, `username` text unique, `password_hash` text, `created_at`, `last_login_at` |
| `rooms` | `id` uuid pk, `code` text unique (6 chars), `name` text, `visibility` enum(public, private), `password_hash` text null, `owner_id` → users, `queue_mode` enum(fifo, fair), `created_at`, `closed_at` null |
| `tracks` | `video_id` text pk, `title`, `channel_title`, `duration_sec` int, `thumbnail_url`, `embeddable` bool, `fetched_at` |
| `queue_items` | `id` uuid pk, `room_id` → rooms, `video_id` → tracks, `added_by` → users, `position` int, `status` enum(queued, playing, played, skipped, removed), `created_at`, `started_at`, `ended_at` |
| `queue_votes` | `queue_item_id` → queue_items, `user_id` → users, `value` smallint (+1/-1); pk(queue_item_id, user_id) |
| `playlists` | `id` uuid pk, `owner_id` → users, `name`, `is_public` bool, `share_slug` text unique, `created_at`, `updated_at` |
| `playlist_items` | `id` uuid pk, `playlist_id` → playlists, `video_id` → tracks, `position` int, `added_at` |
| `likes` | `user_id`, `video_id`, `created_at`; pk(user_id, video_id) |
| `listen_history` | `id`, `user_id`, `video_id`, `room_id`, `played_at` |
| `chat_messages` | `id` uuid pk, `room_id`, `user_id`, `body` text, `created_at`, `deleted_at` null, `deleted_by_admin_id` null |
| `bans` | `id`, `type` enum(user, ip), `value` text, `reason`, `created_by_admin_id`, `created_at`, `expires_at` null |
| `app_settings` | `key` text pk, `value` jsonb, `updated_at`, `updated_by_admin_id` |
| `admin_audit_log` | `id`, `admin_id`, `action` text, `target_type`, `target_id`, `details` jsonb, `created_at` |
| `api_quota_usage` | `date` date pk (Pacific Time), `units` int, `search_calls` int |

Indexes: `queue_items(room_id, status, position)`, `playlist_items(playlist_id, position)`, `chat_messages(room_id, created_at)`, `listen_history(user_id, played_at)`.

### Redis keys

| Key | Type | Content |
|---|---|---|
| `room:{id}:playback` | hash | `queueItemId`, `videoId`, `status` (playing/paused/idle), `positionMs`, `refServerTime`, `version` |
| `room:{id}:members` | hash | userId → JSON `{name, avatar, role, socketCount}` |
| `room:{id}:skipvotes:{queueItemId}` | set | userIds |
| `search:{normalizedQuery}` | string | JSON results, TTL from settings |
| `ratelimit:*` | string | counters |
| `searchcount:{userId}:{date}` | string | per-user daily search count |
| `settings:cache:version` | string | bumps on settings change |

### App settings (keys, defaults)

Defined in `packages/shared/src/settings.ts` with a Zod schema per key.

| Key | Default |
|---|---|
| `features.chat` | true |
| `features.reactions` | true |
| `features.guestRoomCreation` | true |
| `features.publicRooms` | true |
| `features.playlistImport` | true |
| `features.search` | true |
| `limits.maxActiveRooms` | 50 |
| `limits.maxUsersPerRoom` | 30 |
| `limits.maxQueueItemsPerUser` | 5 |
| `limits.maxQueueLength` | 200 |
| `limits.searchesPerUserPerDay` | 10 |
| `limits.maxTrackDurationSec` | 900 |
| `limits.maxPlaylistImportItems` | 200 |
| `limits.chatMessageMaxLength` | 300 |
| `limits.chatMessagesPerMinute` | 20 |
| `queue.skipVoteThreshold` | 0.5 (fraction of members) |
| `sync.driftThresholdMs` | 600 |
| `sync.checkIntervalMs` | 2000 |
| `search.cacheTtlSec` | 604800 (7 days) |
| `search.dailySearchCallBudget` | 95 (leave headroom under YouTube's default) |
| `moderation.wordFilter` | [] |
| `site.maintenanceMode` | false |
| `site.announcement` | null (`{text, level}`) |

### Socket events

Client → server (all payloads Zod-validated):
`time:ping`, `room:join`, `room:leave`, `room:update` (host), `room:setRole` (host), `room:transferHost`, `playback:play`, `playback:pause`, `playback:seek`, `playback:skip` (host/DJ), `playback:voteSkip`, `playback:reportUnavailable`, `queue:add`, `queue:addMany`, `queue:remove`, `queue:reorder`, `queue:vote`, `chat:send`, `chat:react`, `profile:update`

Server → client:
`time:pong`, `room:state` (full snapshot on join), `room:members`, `room:updated`, `room:closed`, `playback:state`, `queue:updated`, `chat:message`, `chat:deleted`, `chat:reaction`, `settings:updated`, `site:announcement`, `user:kicked`, `error`

### Sync algorithm

- **Clock offset:** on connect the client sends 5 `time:ping {t0}`; the server replies `time:pong {t0, serverTime}`. For each sample `offset = serverTime - (t0 + t1) / 2`, where `t1` is the client time on receipt. Use the median. Repeat every 30 s.
- **Expected position:** `positionMs + (serverNow - refServerTime)` when playing; `positionMs` when paused. `serverNow = Date.now() + offset`.
- **Drift correction:** every `sync.checkIntervalMs` while playing, compare `player.getCurrentTime()` to expected. If the difference exceeds `sync.driftThresholdMs`, `seekTo(expected)`. Do not correct while the player state is BUFFERING or during an ad; resync on the next PLAYING state.
- **Track end:** the server owns it. When a track starts, schedule a timer for `duration - position`. On fire, advance the queue. Reschedule on pause/seek. Timers are rebuilt from Redis on api restart.
- **Unavailable video:** if a client's player errors (codes 2, 5, 100, 101, 150), it emits `playback:reportUnavailable`. The server marks `tracks.embeddable = false` and skips once the first report arrives.
- **Autoplay:** the room page shows a "Join audio" button; the player only starts after that click.

---

## Phases

### Phase 0 — Scaffold

- [x] pnpm workspace with `apps/web`, `apps/api`, `packages/shared`
- [x] Shared `tsconfig.base.json` (strict), ESLint (flat config) + Prettier
- [x] Web: Vite React TS, Tailwind v4 via `@tailwindcss/vite`, `shadcn init`, React Router, TanStack Query, Zustand, dark mode toggle
- [x] API: Express + TypeScript (run with `tsx` in dev, compiled with `tsc` for prod), `env.ts` with Zod, `/api/health` route
- [x] Vitest in both apps with one passing test each
- [x] Root scripts: `dev`, `build`, `test`, `lint`, `typecheck`

**Done when:** `pnpm dev` serves the web app with a working dark mode toggle and the web app shows the result of `/api/health`; `pnpm test`, `pnpm lint`, `pnpm typecheck` pass.

**Prompt:**
> Read CLAUDE.md and PLAN.md. Implement Phase 0 exactly as listed. Check the current stable versions of each package before installing. Do not implement anything from later phases.

### Phase 1 — Docker, database, Redis

- [x] `docker-compose.dev.yml`: postgres (current stable major, alpine image) and redis (alpine) with ports exposed to localhost only
- [x] Drizzle schema for all tables in the schema section, first migration generated
- [x] Redis client module
- [x] Settings service: loads `app_settings`, fills missing keys from defaults, caches in memory, `get(key)` typed by key, `set(key, value, adminId)` validates with Zod, writes, bumps version, emits an internal event
- [x] Production `docker-compose.yml`: `caddy`, `api`, `postgres`, `redis`
  - Only Caddy publishes ports 80 and 443
  - Named volumes: `pgdata`, `redisdata`, `caddy_data`, `caddy_config`
  - Memory limits: postgres 384m, redis 96m, api 384m, caddy 64m
  - Postgres command flags: `shared_buffers=128MB`, `max_connections=30`
  - Redis: `--maxmemory 64mb --maxmemory-policy volatile-lru --appendonly yes`
  - Healthchecks on all services; api waits for healthy postgres and redis
- [x] `apps/api/Dockerfile`: multi-stage, node LTS alpine, `pnpm deploy` for prod deps only, runs migrations on start then the server, non-root user
- [x] Web Dockerfile stage that builds the SPA and copies `dist` into a Caddy image
- [x] `caddy/Caddyfile`: `{$DOMAIN}`, serve SPA with fallback to `index.html`, reverse proxy `/api/*` and `/socket.io/*` to `api:3000`, security headers, gzip/zstd
- [x] `.env.example` as in the plan

**Done when:** `docker compose up --build` with `DOMAIN=localhost` serves the app over HTTPS locally, `/api/health` reports db and redis ok, and the settings service has unit tests passing.

**Prompt:**
> Implement Phase 1 from PLAN.md. Keep the memory limits and Postgres/Redis flags exactly as listed. Write tests for the settings service.

### Phase 2 — Guest identity and avatars

- [x] `POST /api/session`: if no valid cookie, create a `users` row with a random name (adjective + animal, from word lists in shared) and a random avatar seed; return the user and a recovery code (shown once)
- [x] Session token: JWT (`jose`) with userId, httpOnly, Secure, SameSite=Lax cookie, 1 year; refresh on use
- [x] Recovery code: 16 chars base32 in groups of 4; store `HMAC-SHA256(RECOVERY_HMAC_SECRET, code)`; `POST /api/session/recover` restores the session; `POST /api/session/recovery-code` regenerates it
- [x] `GET /api/me`, `PATCH /api/me` (display name 2–24 chars, word filter applied, avatar)
- [x] Avatars with `@dicebear/core` + `@dicebear/collection`, rendered client-side from `{style, seed, options}`
- [x] Profile page: name editor, avatar builder (style picker with 6–8 styles, background color, re-roll seed, live preview), recovery code display/regenerate with copy button and a warning that losing it means losing the account on other devices
- [x] Ban check middleware (user ban and IP ban; Express `trust proxy` set for Caddy)

**Done when:** a new browser gets a guest identity, can edit name/avatar, and can restore the same account in a private window using the recovery code. Tests cover session creation, recovery, and name validation.

**Prompt:**
> Implement Phase 2 from PLAN.md. Use @dicebear packages for avatars. Build the profile page with shadcn components.

### Phase 3 — Rooms and presence

- [ ] REST: `POST /api/rooms` (respect `features.guestRoomCreation`, `limits.maxActiveRooms`), `GET /api/rooms` (public rooms with member counts and now playing), `GET /api/rooms/:code`, `PATCH /api/rooms/:code` (host), `POST /api/rooms/:code/close` (host)
- [ ] Private rooms with optional password (argon2 via `@node-rs/argon2`)
- [ ] Socket.IO server with cookie auth, typed events from shared
- [ ] `room:join`: checks password, ban, `limits.maxUsersPerRoom`; adds to `room:{id}:members`; emits `room:state` to the joiner and `room:members` to the room. Multiple tabs from the same user count once (`socketCount`)
- [ ] Roles: host, dj, listener. Host can set roles and transfer host. If the host disconnects for more than 60 s, host passes to the longest-present member
- [ ] Rooms with no members for 30 minutes are closed automatically
- [ ] Web: home page (create room, join by code, public room list), room page shell with member list (avatars, names, role badges), invite link copy, join/leave toasts

**Done when:** two browsers can create/join a room, see each other in the member list, host transfer works on disconnect. Socket integration tests cover join, password, capacity, and host transfer.

**Prompt:**
> Implement Phase 3 from PLAN.md. Write socket integration tests using socket.io-client against a real server instance with test Postgres and Redis.

### Phase 4 — Playback sync (paste a link)

- [ ] YouTube service: `parseVideoId(url)` supporting `youtube.com/watch?v=`, `youtu.be/`, `music.youtube.com/watch?v=`, `youtube.com/shorts/`, raw 11-char IDs; `getVideos(ids[])` via `videos.list` (`part=snippet,contentDetails,status`), parse ISO 8601 duration, upsert `tracks`; record quota units
- [ ] `queue:add` with a URL: validate, check `limits.maxTrackDurationSec`, `status.embeddable`, per-user and total queue limits
- [ ] Playback service implementing the sync algorithm: play/pause/seek/skip (host/DJ), server-side end timer, advance queue, write `listen_history`, rebuild timers from Redis on startup
- [ ] Web: `useYouTubePlayer` hook wrapping the IFrame API (load script once, create player, expose state and controls); `lib/time-sync.ts` for clock offset; drift correction loop; "Join audio" overlay; now-playing card (thumbnail, title, channel, progress bar, who added it); host/DJ controls; local volume slider (not synced); "Resync" button
- [ ] Handle player errors with `playback:reportUnavailable`

**Done when:** in two browsers (and one phone), adding a pasted link plays it on all clients within about 1 s of each other; pause/seek/skip propagate; a late joiner starts at the right position; the next track starts automatically. Unit tests for `parseVideoId`, duration parsing, and the playback service position math.

**Prompt:**
> Implement Phase 4 from PLAN.md, following the Sync algorithm section exactly. Do not use any YouTube wrapper library for React; write the hook directly against the IFrame API.

### Phase 5 — Search, cache, quota

- [ ] `GET /api/search?q=`: normalize query (trim, lowercase, collapse spaces); return Redis cache hit if present; otherwise check `features.search`, per-user `limits.searchesPerUserPerDay`, and global `search.dailySearchCallBudget` (date in America/Los_Angeles)
- [ ] On miss: `search.list` with `type=video`, `videoEmbeddable=true`, `maxResults=15`, then one `videos.list` for durations; upsert tracks; cache for `search.cacheTtlSec`; record quota (search call + units)
- [ ] Responses include `remainingSearchesToday` for the user
- [ ] Web: search sheet/dialog in the room, submit-only (no search-as-you-type), results with thumbnail, title, channel, duration, "Add to queue" and "Add to playlist"; paste-a-link input in the same dialog; clear message when the budget is exhausted ("Search is used up for today — paste a YouTube link instead")

**Done when:** a repeated query does not call YouTube; limits are enforced; quota usage is recorded per day. Tests mock the YouTube HTTP calls.

**Prompt:**
> Implement Phase 5 from PLAN.md. Mock YouTube API responses in tests; never call the real API from tests.

### Phase 6 — Queue features

- [ ] Queue modes: `fifo`, and `fair` (round-robin by `added_by` in order of each user's first item; host can switch)
- [ ] Votes: `queue:vote` (+1/−1); in fifo mode, ordering is by score then created time; in fair mode votes are display-only
- [ ] Vote skip: `playback:voteSkip`; skip when votes ≥ `ceil(members × queue.skipVoteThreshold)`; votes reset per track
- [ ] Host/DJ: drag-and-drop reorder (`@dnd-kit`), remove any item; users can remove their own items
- [ ] Duplicate prevention: a video already queued in the room cannot be added again
- [ ] History tab: tracks played in this room with "Add again"
- [ ] Web: queue panel with avatars of who added each item, score, vote buttons, skip-vote progress

**Done when:** fair mode interleaves users correctly, vote-skip triggers at threshold, reorder persists across refresh. Unit tests for fair ordering and skip threshold.

**Prompt:**
> Implement Phase 6 from PLAN.md. Put queue ordering logic in a pure function with unit tests.

### Phase 7 — Playlists, likes, history

- [ ] REST CRUD: playlists, playlist items (add, remove, reorder), `is_public` toggle, share by `share_slug`
- [ ] Import from YouTube playlist URL via `playlistItems.list` (50 per page) + `videos.list`, capped at `limits.maxPlaylistImportItems`, behind `features.playlistImport`; skip non-embeddable videos and report how many were skipped
- [ ] "Save room history as playlist"
- [ ] "Queue playlist" into a room (`queue:addMany`, respects queue limits; host/DJ can bypass per-user limit)
- [ ] Likes (heart on now-playing and search results) and a Liked Songs view
- [ ] Personal listening history page
- [ ] Web: Library page (playlists, liked songs, history), playlist detail with drag reorder, shared playlist page (read-only, "Copy to my library")

**Done when:** a user can build a playlist from search, import one from YouTube, share it, and queue it into a room.

**Prompt:**
> Implement Phase 7 from PLAN.md.

### Phase 8 — Chat and reactions

- [ ] `chat:send`: length limit, rate limit (`limits.chatMessagesPerMinute`), word filter (mask matches), behind `features.chat`
- [ ] Last 50 messages sent in `room:state`; messages persisted
- [ ] System messages for joins/leaves, track changes, skips
- [ ] `chat:react`: emoji reactions that float over the player for everyone (fixed set of 8 emojis), rate limited, behind `features.reactions`
- [ ] Web: chat panel with avatars, timestamps, auto-scroll with "new messages" pill when scrolled up; on mobile, chat/queue/members are tabs under the player

**Done when:** chat works across clients, rate limit and word filter apply, reactions animate on all clients.

**Prompt:**
> Implement Phase 8 from PLAN.md.

### Phase 9 — Super admin

- [ ] On api start, upsert the admin from `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH`
- [ ] `POST /api/admin/login` (rate limited: 5 attempts / 15 min per IP), separate admin cookie, `POST /api/admin/logout`; all `/api/admin/*` routes require it
- [ ] Settings: `GET /api/admin/settings`, `PUT /api/admin/settings/:key`; changes apply live through the settings service and broadcast `settings:updated` to clients
- [ ] Rooms: list active rooms (members, now playing, queue length), view room, close room, join any room as host override
- [ ] Users: search by name, view, kick from room, ban (user or IP, with duration and reason), unban; list bans
- [ ] Chat moderation: delete any message (`chat:deleted` broadcast), edit word filter
- [ ] Quota dashboard: today's units and search calls vs budget, last 14 days chart
- [ ] Site: maintenance mode (non-admin requests get 503 page; sockets refused), announcement banner (`site:announcement`)
- [ ] Every admin action writes `admin_audit_log`; audit log page with filters
- [ ] Admin socket namespace `/admin` for live counts (rooms, users online)
- [ ] Web: `/admin` lazy-loaded route with sidebar: Dashboard, Settings (form generated from the settings schema, grouped by prefix, with descriptions), Rooms, Users & Bans, Chat, Quota, Audit Log

**Done when:** changing `limits.maxUsersPerRoom` in the admin panel takes effect immediately without restart; ban, kick, close room, maintenance mode, and announcement all work; audit log records each. Tests cover admin auth and settings updates.

**Prompt:**
> Implement Phase 9 from PLAN.md. Generate the settings form from the Zod schemas in packages/shared so new settings appear automatically.

### Phase 10 — Hardening and deploy

- [ ] Rate limits (Redis-backed) on all REST routes and socket events, configurable caps for the expensive ones
- [ ] Helmet / Caddy headers with a CSP that allows `https://www.youtube.com` scripts and frames, `https://i.ytimg.com` images
- [ ] Structured logging (`pino`), log rotation via Docker `json-file` options (`max-size: 10m`, `max-file: 3`)
- [ ] Graceful shutdown: stop accepting sockets, persist playback state, close db/redis
- [ ] Backups: a `backup` service (or host cron) running `pg_dump` nightly, keeping 7 days, plus restore instructions in `README.md`
- [ ] CI (GitHub Actions): lint, typecheck, test, build images, push to GHCR
- [ ] `README.md` deploy steps for the VM:
  1. Add 2 GB swap
  2. Install Docker + Compose
  3. Open ports 80/443, point DNS to the VM
  4. Copy `docker-compose.yml`, `caddy/`, `.env`
  5. `docker compose pull && docker compose up -d`
  6. Check `docker stats` memory usage
- [ ] Production builds happen in CI, not on the VM

**Done when:** the app runs on the VM over HTTPS with your domain, total memory under ~1.2 GB at idle in `docker stats`, a backup file is produced and a restore test succeeds.

**Prompt:**
> Implement Phase 10 from PLAN.md. Write README.md deploy and restore instructions for a 2 GB Ubuntu VM.

---

## Known limitations (by design)

- Listeners without YouTube Premium may see ads; they resync when the ad ends.
- Mobile browsers usually stop YouTube playback when the screen locks or the tab is backgrounded.
- Default YouTube API quota allows about 100 searches per day for the whole app; caching and pasted links reduce usage. More quota requires Google's quota extension request.
- Sync is typically within about 0.3–1 s between listeners (estimate), limited by the IFrame player only allowing seeks for correction.
