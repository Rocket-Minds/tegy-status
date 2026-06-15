# Synthetic User Journey

The public status page is generated from Upptime history and synthetic journey
state, then served from GitHub Pages at `status.tegy.io`.

The full product proof is a separate scheduled Playwright workflow:

1. Open `https://app.tegy.io`.
2. Submit a dedicated synthetic email in the real login UI.
3. Read the real magic-link email captured by the Cloudflare Email Worker.
4. Open the magic link in the browser.
5. Send a fixed cacheable phrase prompt.
6. Verify the phrase appears in the rendered chat response.
7. Log out through the account menu.

The prompt phrase is selected from a pool of 10 two-word phrases, such as
`pink flamingo`, so Cloudflare AI Gateway cache misses are bounded.

## Required GitHub Secrets

Set these in `Rocket-Minds/tegy-status`:

- `TEGY_SYNTHETIC_EMAIL`
- `TEGY_SYNTHETIC_MAGIC_LINK_CAPTURE_URL`
- `TEGY_SYNTHETIC_MAGIC_LINK_CAPTURE_TOKEN`

The email must be on the Tegy invite list and must use the magic-link auth path,
not Google OAuth.

## Magic Link Capture

Cloudflare Email Routing should route `status@synthetic.tegy.io` to the
`tegy-synthetic-magic-link` Worker. The Worker only stores the latest magic link
for that synthetic recipient in KV with a 10-minute TTL.

The browser workflow polls the Worker with a bearer token after it submits the
login form. This keeps the test on the real production auth path without giving
GitHub Actions access to a human mailbox.
