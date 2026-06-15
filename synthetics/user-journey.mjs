import { chromium, expect } from "@playwright/test"
import { ImapFlow } from "imapflow"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const phrases = [
  "pink flamingo",
  "blue lantern",
  "copper harbor",
  "silver comet",
  "green summit",
  "amber compass",
  "violet canyon",
  "red orchard",
  "golden anchor",
  "white pebble",
]

const appUrl = trimTrailingSlash(
  process.env.TEGY_SYNTHETIC_APP_URL || "https://app.tegy.io",
)
const artifactDir =
  process.env.TEGY_SYNTHETIC_ARTIFACT_DIR ||
  path.join(process.cwd(), "synthetics", "artifacts")
const startedAt = new Date()
const phrase = selectPhrase(startedAt)
const prompt = `Reply with exactly: ${phrase}`

await mkdir(artifactDir, { recursive: true })

try {
  await runJourney()
  await writeResult({
    ok: true,
    phrase,
    status: "UP",
  })
} catch (error) {
  await writeResult({
    error: error instanceof Error ? error.message : String(error),
    ok: false,
    phrase,
    status: "DOWN",
  })
  throw error
}

async function runJourney() {
  const email = requiredEnv("TEGY_SYNTHETIC_EMAIL")
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { height: 900, width: 1280 },
  })
  const page = await context.newPage()

  try {
    page.setDefaultTimeout(30_000)
    await page.goto(`${appUrl}/new?synthetic=user-journey`, {
      waitUntil: "domcontentloaded",
    })

    await page.locator("#auth-email").fill(email)
    await page.getByRole("button", { name: /continue/i }).click()
    await expect(page.getByText(/check your email/i)).toBeVisible()

    const magicLink = await waitForMagicLink(startedAt)
    await page.goto(magicLink, { waitUntil: "domcontentloaded" })
    await page.goto(`${appUrl}/new?synthetic=user-journey`, {
      waitUntil: "domcontentloaded",
    })

    const promptBox = page.getByTestId("new-chat-composer-prompt")
    await expect(promptBox).toBeVisible()
    await promptBox.fill(prompt)
    await page.getByTestId("new-chat-composer-submit-button").click()

    await expect(page.getByText(phrase, { exact: true })).toBeVisible({
      timeout: 180_000,
    })
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/)
    await page.screenshot({
      fullPage: true,
      path: path.join(artifactDir, "success.png"),
    })

    await page.getByTestId("sidebar-account-menu-trigger").click()
    await page.getByRole("menuitem", { name: /log out/i }).click()
    await expect(page.locator("#auth-email")).toBeVisible()
  } catch (error) {
    await page.screenshot({
      fullPage: true,
      path: path.join(artifactDir, "failure.png"),
    }).catch(() => undefined)
    throw error
  } finally {
    await context.close()
    await browser.close()
  }
}

async function waitForMagicLink(since) {
  const deadline = Date.now() + getIntegerEnv("TEGY_SYNTHETIC_EMAIL_TIMEOUT_MS", 120_000)

  while (Date.now() < deadline) {
    const link = await findMagicLink(since)

    if (link) {
      return link
    }

    await sleep(5_000)
  }

  throw new Error("Timed out waiting for Tegy magic link email.")
}

async function findMagicLink(since) {
  const client = new ImapFlow({
    auth: {
      pass: requiredEnv("TEGY_SYNTHETIC_IMAP_PASSWORD"),
      user: requiredEnv("TEGY_SYNTHETIC_IMAP_USER"),
    },
    host: requiredEnv("TEGY_SYNTHETIC_IMAP_HOST"),
    logger: false,
    port: getIntegerEnv("TEGY_SYNTHETIC_IMAP_PORT", 993),
    secure: getBooleanEnv("TEGY_SYNTHETIC_IMAP_SECURE", true),
  })

  await client.connect()

  try {
    const lock = await client.getMailboxLock("INBOX")

    try {
      const uids = await client.search({
        since: new Date(since.getTime() - 60_000),
      })
      const recentUids = uids.slice(-25).reverse()

      if (recentUids.length === 0) {
        return null
      }

      for await (const message of client.fetch(recentUids, {
        envelope: true,
        internalDate: true,
        source: true,
      })) {
        if (!isLikelyTegyMagicLinkEmail(message)) {
          continue
        }

        const source = message.source?.toString("utf8") || ""
        const link = extractMagicLink(source)

        if (link) {
          return link
        }
      }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => undefined)
  }

  return null
}

function isLikelyTegyMagicLinkEmail(message) {
  const subject = message.envelope?.subject || ""
  const from = message.envelope?.from || []
  const sentAt = message.internalDate?.getTime() || 0

  return (
    sentAt >= startedAt.getTime() - 60_000 &&
    /sign in to tegy/i.test(subject) &&
    from.some((sender) => /app\.tegy\.io$/i.test(sender.address || ""))
  )
}

function extractMagicLink(source) {
  const match = source.match(
    /https:\/\/app\.tegy\.io\/api\/auth\/magic-link\/verify\?token=[^\s"'<>]+/i,
  )

  return match ? match[0].replace(/&amp;/g, "&") : null
}

async function writeResult(result) {
  const payload = {
    ...result,
    appUrl,
    checkedAt: new Date().toISOString(),
  }

  await writeFile(
    path.join(artifactDir, "result.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  )
}

function selectPhrase(date) {
  const intervalMs = getIntegerEnv("TEGY_SYNTHETIC_PROMPT_INTERVAL_MS", 30 * 60 * 1000)
  const index = Math.floor(date.getTime() / intervalMs) % phrases.length

  return phrases[index]
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "")
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

function getIntegerEnv(name, fallback) {
  const value = process.env[name]?.trim()

  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)

  return Number.isFinite(parsed) ? parsed : fallback
}

function getBooleanEnv(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase()

  if (!value) {
    return fallback
  }

  return value === "1" || value === "true" || value === "yes"
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
