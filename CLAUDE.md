# CLAUDE.md

## Project

ListenTogether: a self-hosted web app where people join rooms and listen to YouTube music in sync. Anonymous guests (random name + avatar), shared queues, playlists, chat, and a super admin panel that controls app configuration live.

The full build plan is in `PLAN.md`. Work one phase at a time. Do not start a phase until the previous phase's "Done when" checks pass. Tick the phase's checkboxes in `PLAN.md` when finished.

## Stack

- Monorepo: pnpm workspaces
  - `apps/web`: React + TypeScript + Vite, Tailwind CSS (latest, v4 via `@tailwindcss/vite`), shadcn/ui (latest), React Router, TanStack Query, Zustand
  - `apps/api`: Node.js (current LTS) + Express + TypeScript + Socket.IO
  - `packages/shared`: Zod schemas, shared types, Socket.IO event maps, constants
- PostgreSQL with Drizzle ORM + drizzle-kit migrations
- Redis for live room state, search cache, rate limits, presence
- Caddy as reverse proxy, static file server for the web build, automatic HTTPS
- Docker Compose for everything
- Tests: Vitest (both apps), Supertest for REST, `socket.io-client` for socket integration tests

## Commands

- `pnpm dev` — run web and api in watch mode (Postgres and Redis via `docker compose -f docker-compose.dev.yml up -d`)
- `pnpm build` — build all packages
- `pnpm test` — run all tests
- `pnpm lint` / `pnpm typecheck`
- `pnpm --filter api db:generate` — generate a migration from schema changes
- `pnpm --filter api db:migrate` — apply migrations
- `pnpm --filter api hash-password <password>` — print an argon2 hash for `ADMIN_PASSWORD_HASH`

Keep these scripts working. If you add or rename one, update this section.

## Rules

- TypeScript `strict: true` everywhere. No `any`. No `@ts-ignore` without a comment explaining why.
- Every REST body/query and every inbound socket payload is validated with a Zod schema from `packages/shared`. Reject invalid payloads; never trust client data.
- The server is the source of truth for room state, queue order, and playback position. Clients only send intents (`queue:add`, `playback:pause`, etc.).
- Socket events use `domain:action` naming and are typed through the event maps in `packages/shared/src/socket-events.ts`.
- Never edit a migration that has already been applied. Generate a new one.
- Read app settings through the settings service (`apps/api/src/services/settings.ts`), never hardcode limits that exist as settings.
- YouTube: use only the official YouTube Data API v3 and the IFrame Player API. Do not use yt-dlp, scraping, InnerTube, or any audio extraction.
- Every YouTube Data API call goes through `apps/api/src/services/youtube.ts`, which records quota usage.
- Memory budget: the production VM has 2 GB RAM. Do not add heavy dependencies (headless browsers, large ML libs, etc.). Ask before adding any new runtime dependency that is not listed in `PLAN.md`.
- Secrets only come from environment variables. Never commit `.env`. Keep `.env.example` up to date.
- Write tests for new services and socket handlers in the same phase they are built.
- UI uses shadcn components and Tailwind utilities. Support light and dark mode. Mobile-first layouts.
- When finding where to change code, refer to file paths and function/component names, not line numbers.
