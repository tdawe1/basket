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
- Docker: `docker compose cp basket:/data ./basket-backup`
- Cloudflare: `npx wrangler d1 export basket --remote --output backup.sql`
