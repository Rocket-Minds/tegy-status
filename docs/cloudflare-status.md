# Cloudflare Status Runtime

`status.tegy.io` is hosted by the `tegy-status` Cloudflare Worker. The Worker is
the status page and the monitor runner.

## Check Flow

Every 30 minutes, Worker Cron runs:

1. HTTP check for `https://tegy.io/`.
2. HTTP check for `https://app.tegy.io/health`.
3. Browser Run check for the production chat user journey.

The browser check uses Cloudflare's Playwright fork:

1. Open `https://app.tegy.io/new?synthetic=status`.
2. Submit `status@synthetic.tegy.io` through the real login form.
3. Read the production magic link from KV after Cloudflare Email Routing invokes
   the Worker's `email()` handler.
4. Open the magic link.
5. Submit `Reply with exactly: <phrase>` in the real composer.
6. Verify the exact phrase renders in the chat response.
7. Log out through the account menu.

The phrase comes from a fixed pool of 10 two-word phrases to keep Cloudflare AI
Gateway cache misses bounded.

## Storage

`STATUS_DATA` stores:

- `component:<slug>` - rolling 90-day component samples.
- `alert:<slug>` - last alert state and last alert timestamp.

`MAGIC_LINKS` stores:

- `latest:<email>` - latest captured magic link, with a 10-minute TTL.

## Alerting

Discord alerts fire when a component enters a non-up state, recovers, or remains
unhealthy long enough to pass the reminder window.

Alerts are sent only from the status Worker. Tegy app production does not need to
know about the status page internals.

## GitHub Dependency

GitHub is intentionally not in the runtime path. A GitHub outage should not stop:

- loading `status.tegy.io`,
- scheduled uptime checks,
- synthetic browser checks,
- Discord status alerts.
