# Tegy Status

`status.tegy.io` is an independent Cloudflare Worker status app for Tegy.

GitHub is only source control. The public status page, scheduled checks, uptime
history, and Discord alerts are served and run by Cloudflare:

- Cloudflare Worker: renders the status UI and JSON API.
- Worker Cron: runs checks every 30 minutes.
- Cloudflare KV: stores rolling check history and alert state.
- Cloudflare Browser Run: runs the browser-backed chat user journey.
- Cloudflare Email Routing: captures the synthetic user's magic-link email.

## Components

The Worker monitors:

- `https://tegy.io/` - public marketing site.
- `https://app.tegy.io/health` - app Worker health endpoint.
- `https://app.tegy.io/new` - browser user journey: login, magic link, composer
  submit, cached model response, and logout.

The browser prompt is selected from 10 fixed two-word phrases, such as
`pink flamingo`, so Cloudflare AI Gateway cache misses stay bounded.

## Commands

```sh
npm run check
npm run dev
npm run deploy
```

Use the Tegy app repo env wrapper when deploying from a local machine that keeps
Cloudflare credentials in SOPS:

```sh
bash ../tegy/3/scripts/env-run.sh -- npm run deploy
```

## Runtime Configuration

Non-secret vars are in `wrangler.toml`:

- `APP_URL`
- `MARKETING_URL`
- `SYNTHETIC_EMAIL`

Required secrets:

- `STATUS_ADMIN_TOKEN` - bearer token for `POST /api/check`.
- `DISCORD_WEBHOOK_URL` - Discord webhook for status alerts.

Optional protected endpoint secret:

- `CAPTURE_TOKEN` - bearer token for `GET /magic-link`; useful for manual
  debugging, not required by the scheduled browser check.

Set secrets with:

```sh
npx wrangler secret put STATUS_ADMIN_TOKEN --config wrangler.toml
npx wrangler secret put DISCORD_WEBHOOK_URL --config wrangler.toml
npx wrangler secret put CAPTURE_TOKEN --config wrangler.toml
```

## Email Routing

Route `status@synthetic.tegy.io` to the `tegy-status` Worker in Cloudflare Email
Routing. The Worker stores the latest synthetic magic link in KV for 10 minutes.

The app production invite list must include `status@synthetic.tegy.io`.

## API

- `GET /` - public status page.
- `GET /api/status` - JSON summary and recent history.
- `POST /api/check` - manually run all checks; requires
  `Authorization: Bearer $STATUS_ADMIN_TOKEN`.
- `GET /health` - status Worker health endpoint.
