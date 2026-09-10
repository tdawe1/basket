# Basket

A shared shopping list for a household. One of you adds milk from the sofa; the other ticks it off in the shop.

The backend is a small [Hono](https://hono.dev) API plus SQLite. No Firebase, no Supabase. Deploy it on **Cloudflare Workers**, **Vercel**, Docker, or Node.

## Cloudflare Workers (fits this app)

SQLite is Cloudflare D1. Free tier is plenty for two people.

```bash
npm install
npx wrangler login
npx wrangler d1 create basket
```

Put the printed `database_id` into `wrangler.jsonc`, then:

```bash
npm run build
npx wrangler d1 migrations apply basket --remote
npm run cf:deploy
```

You’ll get a `*.workers.dev` URL. Both phones open that. HTTPS is included, so Add to Home Screen works.

Local Worker + D1:

```bash
npx wrangler d1 migrations apply basket --local
npm run cf:dev
```

## Vercel

Vercel has no disk, so SQLite has to live somewhere else. Use a libSQL URL (for example [Turso](https://turso.tech), which is SQLite over HTTP):

```bash
npx vercel
```

Environment variables:

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` or `TURSO_DATABASE_URL` | libSQL URL |
| `DATABASE_AUTH_TOKEN` or `TURSO_AUTH_TOKEN` | Token if the host needs one |

If you’d rather not add Turso, use Cloudflare instead. Same app, D1 is included.

## OAuth logins (optional)

Password auth works out of the box. To offer Google/Apple buttons, set:

| Name | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client (redirect URI `<origin>/api/auth/oauth/callback`) |
| `APPLE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | Apple Services ID, Team ID, Key ID, private key |
| `OAUTH_REDIRECT_BASE` | Optional callback base; defaults to the request origin |

On Cloudflare/Vercel, set these as environment variables/secrets instead of
a `.env` file. First-time OAuth users pick Start (new household) or Join
(invite code); returning users use Sign in. Existing members can link/unlink
providers in Settings → Logins. An OAuth-only account cannot unlink its last
login method.

Locked out? There is no email reset. Ask your household member to open
Settings → People → “Make reset code” for you, then use it on the Sign in
tab under “Forgot password?”. Codes are single-use and expire in 30 minutes.

## First time in the app

1. One of you taps **Start**, names the household, picks a username + password.
2. Gear → copy the invite code.
3. The other person taps **Join** and creates their own login.
4. On each phone: browser menu → **Add to Home Screen**.

The list refreshes every couple of seconds while the tab is open.

## Run on this machine (Node / Docker)

Needs Node 22+. Data is `./data/basket.sqlite`.

```bash
npm install
npm run dev          # UI at http://127.0.0.1:5173
```

Production-style:

```bash
npm run build
npm start            # http://127.0.0.1:3000
```

Docker:

```bash
docker compose up -d --build
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080). On phones, use this computer’s LAN address on port 8080.

Optional HTTPS reverse proxy: see `Caddyfile`. Set `COOKIE_SECURE=true` once you are on HTTPS.

## Backup

- Node: copy `data/basket.sqlite`
- Docker: `docker cp $(docker compose ps -q basket):/data ./basket-backup`
- Cloudflare: `npx wrangler d1 export basket --remote --output backup.sql`

## Testing

```bash
npm test          # unit tests (node:test via tsx)
npm run typecheck # strict TypeScript check
```

End-to-end (needs a running server and system Chromium):

```bash
npm run build
PORT=3456 npm start &  # or any port, then BASE_URL=http://127.0.0.1:3456
npm run e2e            # screenshots land in e2e-artifacts/
```

`BASE_URL` overrides the target server (default `http://127.0.0.1:3456`);
`CHROMIUM_PATH` overrides the Chromium binary (default `/usr/bin/chromium`).
