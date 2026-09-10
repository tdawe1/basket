# Repository Guidelines

## Project Overview
- Basket is a self-hosted shared household shopping list: Hono API + SQLite backend, React client, no Firebase/Supabase.
- First-run flow: Start household + user → share invite code (`XXXX-XXXX`) → Join → Add to Home Screen.
- Four deploy targets for one codebase: Node, Docker, Cloudflare Workers + D1, Vercel + libSQL/Turso.
- `migrations/` is the single schema source (`0001` core lists/items, `0002` reminders, `0003` notes); applied via server startup or `wrangler d1 migrations apply`.

## Architecture & Data Flow
- `src/server/app.ts` exports `createApp(getSql, getFiles?)`; per-request middleware injects `Sql` + `FileStore` on context. Default files backend is `sqlFiles(sql)`.
- `Sql` interface (`exec`/`run`/`get`/`all`/`transaction`) has three backends: `sql-node.ts` (`node:sqlite`, WAL + FK + `busy_timeout`), `sql-libsql.ts` (`@libsql/client`), `sql-d1.ts` (D1 shim with quote-aware splitter, pass-through transaction).
- Node entry `src/server/index.ts` opens `openNodeSql(<DATA_DIR>/basket.sqlite)` + `diskFiles(<DATA_DIR>/files)` and serves `dist/client` statically in production. Worker entry `src/worker.ts` builds `fromD1(c.env.DB)` per request plus once-per-isolate `ensureSchema` self-heal.
- Request path: `src/client/api.ts` fetch → Hono `/api/*` routes → `src/server/db.ts` query helpers (household-scoped, row→public mappers) → `Sql`.
- Files path: `FileStore` interface; `sqlFiles`/`memoryFiles` in `files.ts` store base64 `note_blobs`, `diskFiles` in `files-disk.ts` writes `<id>.bin` + `.mime`.
- Client `src/client/App.tsx` holds all state in `useState` (user/household/lists/items/reminders/notes); full `bootstrap()` reload on 2.5s `setInterval` when visible + `visibilitychange` + clamped reminder-due `setTimeout`. No router, store, or websocket.

## Key Directories
- `src/server/` — Hono app, auth, db helpers, `Sql`/file backends, entries, unit tests.
- `src/client/` — React app (`App.tsx`, `api.ts`, `Notes.tsx`, `i18n.ts`, `notify.ts`).
- `src/shared/` — shared types, `calendar.ts` (ICS/URL builders), `categories.ts` (guess + quick-add parser), unit test.
- `migrations/` — sequential SQLite schema (`0001_init.sql`, `0002_reminders.sql`, `0003_notes.sql`).
- `scripts/` — only `scripts/e2e.mjs` (puppeteer walkthrough); `e2e-artifacts/` holds its numbered `*.png` screenshots.
- `api/` — Vercel serverless entry (`api/index.ts`, `createApp` over libSQL).

## Development Commands
- `npm install`, then `npm run dev` — runs `tsx watch src/server/index.ts` + `vite` concurrently; UI `:5173`, API `:3000` (vite proxies `/api/` + `/ws` to `127.0.0.1:3000`).
- `npm test` — unit tests (see Testing & QA).
- `npm run build` + `npm start` — production build to `dist/client`, serve on `:3000` (`NODE_ENV=production`).
- `node scripts/e2e.mjs` (or `npm run e2e`) — e2e walkthrough; needs a running server at `BASE_URL` (default `http://127.0.0.1:3456`) plus `/usr/bin/chromium`.
- `npm run cf:dev` / `npm run cf:deploy` — build then `wrangler dev` / `wrangler deploy` (D1 binding `DB`).
- Docker: `docker compose up -d --build` — maps `8080:3000`, `DATA_DIR=/data` on `basket-data` volume, healthcheck `/api/health`.
- Backup: copy `data/basket.sqlite` (Node), `docker compose cp basket:/data ./basket-backup` (Docker), `npx wrangler d1 export basket --remote --output backup.sql` (Cloudflare).

## Code Conventions & Common Patterns
- Errors: route handlers return `c.json({ error: '<Sentence with period.>' }, 4xx)`; unexpected paths use `genericServerErrorResponse()` from `http-error.ts` (500 `Something went wrong.`). Never leak `err.message` to clients.
- Auth (`auth.ts`): PBKDF2-SHA256 100k via WebCrypto, `timingSafeEqual` compare, httpOnly Lax cookie `basket`, `SESSION_MS=180d`; validators return message strings; in-memory login throttle (5 fails/15min).
- Client API (`src/client/api.ts`): `request()` wrapper throws `ApiError(status, message)`, always `credentials: 'include'`; note file upload uses `FormData`, download disposition via `?download=1`.
- Note files: sniff magic bytes (`files.ts`), allow pdf/png/jpeg/webp only; `SQL_FILE_MAX_BYTES=700KB` for DB-backed store, `files.maxBytes ?? 8MB` default cap → 413 on oversize.
- Shared helpers are pure: `calendar.ts` (`toIcsUtc`, `buildIcs`, Google/Outlook URLs, `presetDue`), `categories.ts` (`guessCategory` EN+JA keywords default `other`, `parseQuickAdd` for `2x milk`).
- i18n: `src/client/i18n.ts` en/ja dicts via provider + `useT` with `{var}` interpolation; notifications via `notify.ts` + service worker, deduped in `localStorage basket-seen-reminders` (cap 120).
- Imports use explicit `.ts` extensions (e.g. `./calendar.ts`); keep them — `tsx` and wrangler resolve this way.

## Important Files
- `src/server/app.ts` — `createApp` factory, all `/api/*` routes, session wiring.
- `src/server/index.ts` — Node entry (`openNodeSql`, `diskFiles`, `serve`, static `dist/client`).
- `src/worker.ts` — Cloudflare Worker entry (`fromD1`, schema self-heal).
- `api/index.ts` — Vercel entry (`createApp` over libSQL via `DATABASE_URL`/`TURSO_*`).
- `src/server/db.ts`, `src/server/sql.ts` — query helpers/mappers; `Sql` interface + `SCHEMA`/`ensureSchema`.
- `src/server/auth.ts`, `src/server/files.ts`, `src/server/http-error.ts` — auth/throttle, file stores, 500 helper.
- `src/client/api.ts`, `src/client/App.tsx` — fetch wrapper; monolithic polling state.
- `package.json`, `vite.config.ts`, `wrangler.jsonc`, `vercel.json`, `tsconfig.json` — scripts/engines, client root/outDir + proxy, D1 binding + assets, Vercel build/output, strict TS config.
- `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.env.example` — image, compose, HTTPS proxy example, `PORT`/`HOST`/`DATA_DIR`/`SESSION_SECRET`/`COOKIE_SECURE` knobs.

## Runtime/Tooling Preferences
- Node `>=22` required (`package.json` engines); Docker image builds on `node:24`; no other runtime supported.
- Ports: dev UI `5173`, API `3000`, e2e default `3456`, Docker published `8080`. Set `COOKIE_SECURE=true` on HTTPS (Caddyfile is only a reverse-proxy example to `127.0.0.1:8080`).
- Env knobs: `PORT`, `HOST`, `DATA_DIR`, `SESSION_SECRET`, `COOKIE_SECURE`; Vercel needs a libSQL URL (`DATABASE_URL`/`TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`) because it has no disk for SQLite.
- TypeScript strict, ES2022, `bundler` resolution, `noEmit`; no linter configured — do not add lint commands.

## Testing & QA
- Framework: `node:test` (`describe`/`it`) + `node:assert/strict`, run via `tsx --test` (no vitest/jest/playwright); `api.test.ts` pins `{ concurrency: 1 }`.
- `npm test` runs `tsx --test src/server/api.test.ts src/server/files.test.ts src/shared/calendar.test.ts`.
- `api.test.ts` self-provisions (`mkdtempSync` + `openNodeSql(test.sqlite)` + `createApp(()=>sql)`); cookie-jar `Map` simulates sessions; throttle test uses `resetLoginThrottleForTests()`.
- `files.test.ts` includes source-text guards on `src/worker.ts` (generic 500) and `src/client/App.tsx` (patch/undo symbols) — renaming those symbols/strings breaks tests by design.
- `calendar.test.ts` is fully pure (fixed 2026 dates, local-time presets).
- E2E: `npm run e2e` drives `BASE_URL` with system Chromium at `/usr/bin/chromium` (`--no-sandbox`), writes `e2e-artifacts/*.png`; server must already be built + running.
