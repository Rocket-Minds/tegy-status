import {
  launch,
  type BrowserWorker,
  type Locator,
  type Page,
} from "@cloudflare/playwright"

type Env = {
  APP_URL?: string
  BROWSER: BrowserWorker
  CAPTURE_TOKEN?: string
  DISCORD_WEBHOOK_URL?: string
  MAGIC_LINKS: KVNamespace
  MARKETING_URL?: string
  STATUS_ADMIN_TOKEN?: string
  STATUS_DATA: KVNamespace
  SYNTHETIC_EMAIL?: string
}

type CheckStatus =
  | "up"
  | "degraded"
  | "down"
  | "not_configured"
  | "stale"
  | "unknown"

type ComponentKind = "http" | "browser"

type ComponentDefinition = {
  description: string
  kind: ComponentKind
  name: string
  slug: string
  url: string
}

type CheckSample = {
  chatUrl?: string
  checkedAt: string
  consoleMessages?: string[]
  currentUrl?: string
  error?: string
  phase?: string
  phrase?: string
  responseTimeMs: number | null
  status: CheckStatus
}

type StoredComponent = ComponentDefinition & {
  samples: CheckSample[]
  updatedAt: string
}

type ComponentSummary = ComponentDefinition & {
  days: DaySummary[]
  lastSample: CheckSample | null
  responseTimeMs: number | null
  status: CheckStatus
  uptimePercent: number | null
  updatedAt: string | null
}

type DaySummary = {
  iso: string
  label: string
  sampleCount: number
  state: CheckStatus
  uptimePercent: number | null
}

type MagicLinkRecord = {
  from: string
  magicLink: string
  receivedAt: string
  subject: string
  to: string
}

type AlertState = {
  lastAlertAt?: string
  lastStatus?: CheckStatus
}

const appUrlDefault = "https://app.tegy.io"
const marketingUrlDefault = "https://tegy.io"
const syntheticEmailDefault = "status@synthetic.tegy.io"
const historyDays = 90
const sampleRetentionMs = historyDays * 24 * 60 * 60 * 1000
const staleAfterMs = 90 * 60 * 1000
const alertReminderMs = 3 * 60 * 60 * 1000
const magicLinkTtlSeconds = 10 * 60
const promptIntervalMs = 30 * 60 * 1000
const syntheticBrowserKeepAliveMs = 5 * 60 * 1000
const syntheticPhraseTimeoutMs = 180 * 1000
const syntheticChatNavigationTimeoutMs = 30 * 1000
const syntheticWaitHeartbeatMs = 10 * 1000
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)

    if (url.pathname === "/health") {
      return json({ ok: true })
    }

    if (url.pathname === "/api/status") {
      return json(await loadSummary(env))
    }

    if (url.pathname === "/api/check") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, { status: 405 })
      }

      if (!isAuthorized(request, env.STATUS_ADMIN_TOKEN)) {
        return json({ error: "Unauthorized" }, { status: 401 })
      }

      const summary = await runAllChecks(env)
      return json(summary)
    }

    if (url.pathname === "/magic-link") {
      return handleMagicLinkRequest(request, env)
    }

    const historyMatch = url.pathname.match(/^\/history\/([^/]+)\/?$/)
    if (historyMatch) {
      const summary = await loadSummary(env)
      const component = summary.components.find(
        (item) => item.slug === decodeURIComponent(historyMatch[1]),
      )

      if (!component) {
        return html(renderNotFound(), 404)
      }

      return html(renderHistoryPage(summary, component))
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const summary = await loadSummary(env)

      if (summary.components.every((component) => component.status === "unknown")) {
        ctx.waitUntil(runAllChecks(env))
      }

      return html(renderIndexPage(summary))
    }

    return html(renderNotFound(), 404)
  },

  async scheduled(_controller: ScheduledController, env: Env) {
    await runAllChecks(env)
  },

  async email(message: ForwardableEmailMessage, env: Env) {
    const to = normalizeEmail(message.to)
    const expectedTo = normalizeEmail(env.SYNTHETIC_EMAIL || syntheticEmailDefault)

    if (to !== expectedTo) {
      message.setReject(`Unexpected synthetic recipient: ${message.to}`)
      return
    }

    const raw = await new Response(message.raw).text()
    const magicLink = extractMagicLink(raw)

    await env.MAGIC_LINKS.put(
      keyForMagicLink(to),
      JSON.stringify({
        from: message.from,
        magicLink: magicLink || "",
        receivedAt: new Date().toISOString(),
        subject: message.headers.get("subject") || "",
        to: message.to,
      } satisfies MagicLinkRecord),
      { expirationTtl: magicLinkTtlSeconds },
    )
  },
}

async function runAllChecks(env: Env) {
  const definitions = getComponentDefinitions(env)
  const checks = [
    runHttpCheck(definitions[0]),
    runHttpCheck(definitions[1]),
    runSyntheticJourney(definitions[2], env),
  ]
  const settled = await Promise.allSettled(checks)

  await Promise.all(
    settled.map((result, index) => {
      const definition = definitions[index]
      const sample =
        result.status === "fulfilled"
          ? result.value
          : failedSample(
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
            )

      return persistSample(env, definition, sample)
    }),
  )

  return loadSummary(env)
}

function getComponentDefinitions(env: Env): ComponentDefinition[] {
  const appUrl = trimTrailingSlash(env.APP_URL || appUrlDefault)
  const marketingUrl = trimTrailingSlash(env.MARKETING_URL || marketingUrlDefault)

  return [
    {
      description: "Public marketing website homepage.",
      kind: "http",
      name: "Tegy marketing site",
      slug: "tegy-marketing-site",
      url: `${marketingUrl}/`,
    },
    {
      description: "Application Worker health endpoint.",
      kind: "http",
      name: "Tegy app health",
      slug: "tegy-app-health",
      url: `${appUrl}/health`,
    },
    {
      description:
        "Browser login, magic link, composer submit, cached model response, and logout.",
      kind: "browser",
      name: "Tegy chat user journey",
      slug: "tegy-chat-user-journey",
      url: `${appUrl}/new`,
    },
  ]
}

async function runHttpCheck(definition: ComponentDefinition): Promise<CheckSample> {
  const startedAt = performance.now()

  try {
    const response = await fetchWithTimeout(definition.url, 20_000)
    const responseTimeMs = Math.round(performance.now() - startedAt)

    if (response.ok) {
      return {
        checkedAt: new Date().toISOString(),
        responseTimeMs,
        status: "up",
      }
    }

    return {
      checkedAt: new Date().toISOString(),
      error: `HTTP ${response.status}`,
      responseTimeMs,
      status: "down",
    }
  } catch (error) {
    return failedSample(errorMessage(error), Math.round(performance.now() - startedAt))
  }
}

async function runSyntheticJourney(
  definition: ComponentDefinition,
  env: Env,
): Promise<CheckSample> {
  const startedAt = new Date()
  const startedMs = performance.now()
  const email = normalizeEmail(env.SYNTHETIC_EMAIL || syntheticEmailDefault)
  const appUrl = trimTrailingSlash(env.APP_URL || appUrlDefault)
  const phrase = selectPhrase(startedAt)
  const prompt = `Reply with exactly: ${phrase}`
  const consoleMessages: string[] = []
  let chatUrl: string | undefined
  let currentUrl: string | undefined
  let phase = "launch-browser"
  const browser = await launch(env.BROWSER, {
    keep_alive: syntheticBrowserKeepAliveMs,
  })
  const page = await browser.newPage({
    viewport: { height: 900, width: 1280 },
  })

  try {
    page.on("console", (message) => {
      if (!["error", "warning"].includes(message.type())) return

      consoleMessages.push(
        truncate(`${message.type()}: ${message.text()}`, 500),
      )
    })

    page.setDefaultTimeout(30_000)
    phase = "open-login"
    await page.goto(`${definition.url}?synthetic=status`, {
      waitUntil: "domcontentloaded",
    })
    currentUrl = page.url()

    phase = "submit-email"
    await page.locator("#auth-email").fill(email)
    await page.getByRole("button", { name: /continue/i }).click()
    phase = "await-email-screen"
    await page.getByText(/check your email/i).waitFor()

    phase = "await-magic-link"
    const magicLink = await waitForMagicLink(env, email, startedAt)
    phase = "open-magic-link"
    await page.goto(magicLink, { waitUntil: "domcontentloaded" })
    currentUrl = page.url()
    phase = "open-new-chat"
    await page.goto(`${appUrl}/new?synthetic=status`, {
      waitUntil: "domcontentloaded",
    })
    currentUrl = page.url()

    phase = "await-composer"
    const promptBox = page.getByTestId("new-chat-composer-prompt")
    await promptBox.waitFor()
    phase = "fill-composer"
    await promptBox.fill(prompt)
    phase = "submit-composer"
    await page.getByTestId("new-chat-composer-submit-button").click()
    currentUrl = page.url()
    phase = "await-chat-url"
    await page.waitForURL(/\/chat\/[0-9a-f-]+/, {
      timeout: syntheticChatNavigationTimeoutMs,
    })
    chatUrl = page.url()
    currentUrl = chatUrl
    phase = "await-phrase"
    await waitForVisibleWithHeartbeat({
      locator: page.getByText(phrase, { exact: true }),
      page,
      timeoutMs: syntheticPhraseTimeoutMs,
    })

    phase = "logout-open-menu"
    await page.getByTestId("sidebar-account-menu-trigger").click()
    phase = "logout-click"
    await page.getByRole("menuitem", { name: /log out/i }).click()
    phase = "await-login-after-logout"
    await page.locator("#auth-email").waitFor({ timeout: 30_000 })

    return {
      chatUrl,
      checkedAt: new Date().toISOString(),
      consoleMessages: trimDiagnostics(consoleMessages),
      currentUrl: page.url(),
      phase,
      phrase,
      responseTimeMs: Math.round(performance.now() - startedMs),
      status: "up",
    }
  } catch (error) {
    return failedSample(errorMessage(error), Math.round(performance.now() - startedMs), {
      chatUrl,
      consoleMessages: trimDiagnostics(consoleMessages),
      currentUrl: safePageUrl(page, currentUrl),
      phase,
      phrase,
    })
  } finally {
    await browser.close().catch(() => undefined)
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function waitForMagicLink(env: Env, email: string, since: Date) {
  const deadline = Date.now() + 120_000

  while (Date.now() < deadline) {
    const record = await env.MAGIC_LINKS.get<MagicLinkRecord>(keyForMagicLink(email), {
      type: "json",
    })

    if (
      record?.magicLink &&
      Date.parse(record.receivedAt) >= since.getTime() &&
      normalizeEmail(record.to) === email
    ) {
      return record.magicLink
    }

    await sleep(5_000)
  }

  throw new Error("Timed out waiting for Tegy magic link email.")
}

async function persistSample(
  env: Env,
  definition: ComponentDefinition,
  sample: CheckSample,
) {
  const existing = await loadStoredComponent(env, definition)
  const classifiedSample = classifySample(definition, existing, sample)
  const cutoff = Date.now() - sampleRetentionMs
  const samples = [...existing.samples, classifiedSample].filter(
    (item) => Date.parse(item.checkedAt) >= cutoff,
  )
  const next: StoredComponent = {
    ...definition,
    samples,
    updatedAt: classifiedSample.checkedAt,
  }
  const previousStatus = deriveCurrentStatus(existing.samples.at(-1))

  await env.STATUS_DATA.put(componentKey(definition.slug), JSON.stringify(next))
  await maybeSendAlert(env, definition, previousStatus, classifiedSample)
}

async function loadSummary(env: Env) {
  const definitions = getComponentDefinitions(env)
  const components = await Promise.all(
    definitions.map(async (definition) =>
      summarizeComponent(await loadStoredComponent(env, definition)),
    ),
  )
  const status = deriveGlobalStatus(components)

  return {
    components,
    generatedAt: new Date().toISOString(),
    status,
    title: titleForGlobalStatus(status),
  }
}

async function loadStoredComponent(env: Env, definition: ComponentDefinition) {
  const stored = await env.STATUS_DATA.get<StoredComponent>(
    componentKey(definition.slug),
    { type: "json" },
  )

  if (!stored) {
    return {
      ...definition,
      samples: [],
      updatedAt: new Date(0).toISOString(),
    }
  }

  return {
    ...definition,
    samples: Array.isArray(stored.samples) ? stored.samples : [],
    updatedAt: stored.updatedAt || new Date(0).toISOString(),
  }
}

function summarizeComponent(component: StoredComponent): ComponentSummary {
  const samples = component.samples
  const lastSample = samples.at(-1) || null
  const status = deriveCurrentStatus(lastSample)
  const recentSamples = samples.filter((sample) => sample.status !== "unknown")
  const upCount = recentSamples.filter((sample) => sample.status === "up").length
  const uptimePercent =
    recentSamples.length > 0 ? (upCount / recentSamples.length) * 100 : null
  const successfulResponseTimes = recentSamples
    .map((sample) => sample.responseTimeMs)
    .filter((value): value is number => typeof value === "number")
  const responseTimeMs =
    successfulResponseTimes.length > 0
      ? Math.round(
          successfulResponseTimes.reduce((sum, value) => sum + value, 0) /
            successfulResponseTimes.length,
        )
      : null

  return {
    description: component.description,
    days: buildDays(samples),
    kind: component.kind,
    lastSample,
    name: component.name,
    responseTimeMs,
    slug: component.slug,
    status,
    updatedAt: lastSample?.checkedAt || null,
    uptimePercent,
    url: component.url,
  }
}

function buildDays(samples: CheckSample[]) {
  const days: DaySummary[] = []
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  for (let index = historyDays - 1; index >= 0; index -= 1) {
    const date = new Date(today)
    date.setUTCDate(today.getUTCDate() - index)
    const iso = date.toISOString().slice(0, 10)
    const daySamples = samples.filter((sample) => sample.checkedAt.startsWith(iso))
    const upSamples = daySamples.filter((sample) => sample.status === "up").length
    const state = summarizeDayState(daySamples)

    days.push({
      iso,
      label: date.toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
        year: "numeric",
      }),
      sampleCount: daySamples.length,
      state,
      uptimePercent:
        daySamples.length > 0 ? (upSamples / daySamples.length) * 100 : null,
    })
  }

  return days
}

function summarizeDayState(samples: CheckSample[]): CheckStatus {
  if (samples.length === 0) return "unknown"
  if (samples.every((sample) => sample.status === "up")) return "up"
  if (samples.every((sample) => sample.status === "down")) return "down"
  if (samples.some((sample) => sample.status === "down")) return "degraded"
  if (samples.some((sample) => sample.status === "not_configured")) {
    return "not_configured"
  }
  return "degraded"
}

function classifySample(
  definition: ComponentDefinition,
  existing: StoredComponent,
  sample: CheckSample,
): CheckSample {
  if (definition.kind !== "browser" || sample.status === "up") {
    return sample
  }

  const previousStatus = deriveCurrentStatus(existing.samples.at(-1))

  return {
    ...sample,
    status: ["down", "degraded"].includes(previousStatus) ? "down" : "degraded",
  }
}

function deriveCurrentStatus(sample: CheckSample | null | undefined): CheckStatus {
  if (!sample) return "unknown"
  if (Date.now() - Date.parse(sample.checkedAt) > staleAfterMs) return "stale"
  return sample.status
}

function deriveGlobalStatus(components: ComponentSummary[]): CheckStatus {
  if (components.some((component) => component.status === "down")) return "down"
  if (
    components.some((component) =>
      ["degraded", "not_configured", "stale", "unknown"].includes(component.status),
    )
  ) {
    return "degraded"
  }
  return "up"
}

async function maybeSendAlert(
  env: Env,
  definition: ComponentDefinition,
  previousStatus: CheckStatus,
  sample: CheckSample,
) {
  if (!env.DISCORD_WEBHOOK_URL) return

  const alertState = await env.STATUS_DATA.get<AlertState>(alertKey(definition.slug), {
    type: "json",
  })
  const currentStatus = sample.status
  const lastAlertAt = Date.parse(alertState?.lastAlertAt || "")
  const shouldSendRecovery =
    currentStatus === "up" &&
    alertState?.lastStatus &&
    alertState.lastStatus !== "up"
  const shouldSendFailure =
    currentStatus !== "up" &&
    (previousStatus === "up" ||
      previousStatus === "unknown" ||
      alertState?.lastStatus !== currentStatus ||
      !Number.isFinite(lastAlertAt) ||
      Date.now() - lastAlertAt > alertReminderMs)

  if (!shouldSendRecovery && !shouldSendFailure) {
    await env.STATUS_DATA.put(
      alertKey(definition.slug),
      JSON.stringify({
        ...alertState,
        lastStatus: currentStatus,
      } satisfies AlertState),
    )
    return
  }

  const content =
    currentStatus === "up"
      ? `Tegy status recovered: ${definition.name} is up.`
      : `Tegy status alert: ${definition.name} is ${labelStatus(currentStatus)}.`
  const fields = [
    { name: "Component", value: definition.name, inline: true },
    { name: "Status", value: labelStatus(currentStatus), inline: true },
    { name: "URL", value: definition.url, inline: false },
  ]

  if (sample.phase) {
    fields.push({
      name: "Phase",
      value: truncate(sample.phase, 200),
      inline: true,
    })
  }

  if (sample.phrase) {
    fields.push({
      name: "Phrase",
      value: truncate(sample.phrase, 200),
      inline: true,
    })
  }

  if (sample.currentUrl) {
    fields.push({
      name: "Current URL",
      value: truncate(sample.currentUrl, 900),
      inline: false,
    })
  }

  if (sample.chatUrl) {
    fields.push({
      name: "Chat URL",
      value: truncate(sample.chatUrl, 900),
      inline: false,
    })
  }

  if (sample.error) {
    fields.push({
      name: "Error",
      value: truncate(sample.error, 900),
      inline: false,
    })
  }

  if (sample.consoleMessages?.length) {
    fields.push({
      name: "Console",
      value: truncate(sample.consoleMessages.join("\n"), 900),
      inline: false,
    })
  }

  await fetch(env.DISCORD_WEBHOOK_URL, {
    body: JSON.stringify({
      content,
      embeds: [
        {
          color: currentStatus === "up" ? 0x1f883d : 0xcf222e,
          fields,
          footer: { text: "status.tegy.io" },
          timestamp: sample.checkedAt,
          title: content,
          url: "https://status.tegy.io",
        },
      ],
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }).catch(() => undefined)

  await env.STATUS_DATA.put(
    alertKey(definition.slug),
    JSON.stringify({
      lastAlertAt: new Date().toISOString(),
      lastStatus: currentStatus,
    } satisfies AlertState),
  )
}

function handleMagicLinkRequest(request: Request, env: Env) {
  const url = new URL(request.url)

  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, { status: 405 })
  }

  if (!isAuthorized(request, env.CAPTURE_TOKEN)) {
    return json({ error: "Unauthorized" }, { status: 401 })
  }

  const email = normalizeEmail(url.searchParams.get("email"))
  const expectedEmail = normalizeEmail(env.SYNTHETIC_EMAIL || syntheticEmailDefault)
  const since = Date.parse(url.searchParams.get("since") || "")

  if (!email || email !== expectedEmail) {
    return json({ error: "Unknown mailbox" }, { status: 404 })
  }

  return env.MAGIC_LINKS.get<MagicLinkRecord>(keyForMagicLink(email), {
    type: "json",
  }).then((record) => {
    if (
      !record ||
      (Number.isFinite(since) && Date.parse(record.receivedAt) < since)
    ) {
      return json({ error: "Magic link not found" }, { status: 404 })
    }

    return json(record)
  })
}

function renderIndexPage(summary: Awaited<ReturnType<typeof loadSummary>>) {
  const allUnknown = summary.components.every(
    (component) => component.status === "unknown",
  )

  return pageShell({
    description: "Tegy service status and uptime history.",
    title: "Tegy Status",
    body: `
      <header class="hero">
        <nav class="nav">
          <a class="brand" href="/">
            <img src="https://app.tegy.io/favicon.svg" alt="" />
            <span>Tegy Status</span>
          </a>
          <div class="links">
            <a href="https://tegy.io">Website</a>
            <a href="https://app.tegy.io">App</a>
            <a href="/api/status">API</a>
          </div>
        </nav>
        <section class="banner ${summary.status === "up" ? "banner-ok" : "banner-alert"}">
          <div>
            <p class="eyebrow">Current Status</p>
            <h1>${escapeHtml(allUnknown ? "Status Checks Starting" : summary.title)}</h1>
          </div>
          <span class="status-dot ${summary.status === "up" ? "dot-ok" : "dot-alert"}"></span>
        </section>
      </header>

      <main>
        <section class="panel">
          <div class="panel-heading">
            <div>
              <h2>Current Status</h2>
              <p>Cloudflare Worker checks with ${historyDays}-day history.</p>
            </div>
            <span>Updated ${escapeHtml(formatMaybeDate(summary.generatedAt))}</span>
          </div>
          <div class="components">
            ${summary.components.map(renderComponentRow).join("")}
          </div>
        </section>

        <section class="panel incidents">
          <div class="panel-heading">
            <div>
              <h2>Incident History</h2>
              <p>Recent days with failed or degraded checks.</p>
            </div>
          </div>
          ${renderIncidents(summary.components)}
        </section>
      </main>

      <footer>
        <span>Backed by Cloudflare Workers, Worker Cron, Browser Run, and KV.</span>
        <span>GitHub is source control only, not a runtime dependency.</span>
      </footer>
    `,
  })
}

function renderHistoryPage(
  summary: Awaited<ReturnType<typeof loadSummary>>,
  component: ComponentSummary,
) {
  return pageShell({
    description: `${component.name} uptime history.`,
    title: `${component.name} - Tegy Status`,
    body: `
      <header class="hero compact">
        <nav class="nav">
          <a class="brand" href="/">
            <img src="https://app.tegy.io/favicon.svg" alt="" />
            <span>Tegy Status</span>
          </a>
          <div class="links">
            <a href="/">Status</a>
            <a href="/api/status">API</a>
          </div>
        </nav>
      </header>
      <main>
        <section class="panel detail">
          <p class="eyebrow">Component</p>
          <h1>${escapeHtml(component.name)}</h1>
          <p>${escapeHtml(component.description)}</p>
          <div class="detail-grid">
            <div><span>Current status</span><strong>${escapeHtml(labelStatus(component.status))}</strong></div>
            <div><span>Uptime</span><strong>${escapeHtml(formatPercent(component.uptimePercent))}</strong></div>
            <div><span>Average response</span><strong>${escapeHtml(formatResponseTime(component.responseTimeMs))}</strong></div>
            <div><span>Last checked</span><strong>${escapeHtml(formatMaybeDate(component.updatedAt))}</strong></div>
          </div>
          ${renderBars(component, "large")}
          ${component.lastSample?.error ? `<pre class="error">${escapeHtml(component.lastSample.error)}</pre>` : ""}
          ${renderSampleDiagnostics(component.lastSample)}
        </section>
      </main>
      <footer>
        <span>${escapeHtml(summary.title)}</span>
        <span>Generated ${escapeHtml(formatMaybeDate(summary.generatedAt))}</span>
      </footer>
    `,
  })
}

function renderSampleDiagnostics(sample: CheckSample | null) {
  if (!sample) return ""

  const rows = [
    ["Phase", sample.phase],
    ["Phrase", sample.phrase],
    ["Current URL", sample.currentUrl],
    ["Chat URL", sample.chatUrl],
    [
      "Console",
      sample.consoleMessages?.length ? sample.consoleMessages.join("\n") : undefined,
    ],
  ].filter((row): row is [string, string] => Boolean(row[1]))

  if (rows.length === 0) return ""

  return `
    <dl class="sample-diagnostics">
      ${rows
        .map(
          ([label, value]) => `
            <div>
              <dt>${escapeHtml(label)}</dt>
              <dd>${escapeHtml(value)}</dd>
            </div>
          `,
        )
        .join("")}
    </dl>
  `
}

function renderComponentRow(component: ComponentSummary) {
  return `
    <article class="component">
      <div class="component-top">
        <div>
          <h3><a href="/history/${encodeURIComponent(component.slug)}/">${escapeHtml(component.name)}</a></h3>
          <p>${escapeHtml(component.description)}</p>
          <p>${escapeHtml(component.url)}</p>
        </div>
        <div class="metrics">
          <span class="pill ${pillClass(component.status)}">${escapeHtml(labelStatus(component.status))}</span>
          <span>${escapeHtml(formatPercent(component.uptimePercent))} uptime</span>
          <span>${escapeHtml(formatResponseTime(component.responseTimeMs))}</span>
        </div>
      </div>
      ${renderBars(component)}
    </article>
  `
}

function renderBars(component: ComponentSummary, size = "") {
  return `
    <div class="uptime-wrap ${size === "large" ? "uptime-large" : ""}" aria-label="${escapeHtml(component.name)} ${historyDays}-day uptime history">
      <div class="uptime-bars">
        ${component.days
          .map(
            (day) => `
              <span
                class="bar bar-${day.state}"
                title="${escapeHtml(`${day.label}: ${formatDay(day)}`)}"
                aria-label="${escapeHtml(`${day.label}: ${formatDay(day)}`)}"
              ></span>
            `,
          )
          .join("")}
      </div>
      <div class="axis">
        <span>${historyDays} days ago</span>
        <span>Today</span>
      </div>
    </div>
  `
}

function renderIncidents(components: ComponentSummary[]) {
  const incidentDays = components.flatMap((component) =>
    component.days
      .filter((day) => ["degraded", "down", "not_configured"].includes(day.state))
      .map((day) => ({ component, day })),
  )

  if (incidentDays.length === 0) {
    return `<div class="empty">No incidents reported in the last ${historyDays} days.</div>`
  }

  return `
    <ol class="incident-list">
      ${incidentDays
        .reverse()
        .slice(0, 30)
        .map(
          ({ component, day }) => `
            <li>
              <strong>${escapeHtml(day.label)}</strong>
              <span>${escapeHtml(component.name)} was ${escapeHtml(formatDay(day).toLowerCase())}.</span>
            </li>
          `,
        )
        .join("")}
    </ol>
  `
}

function pageShell({
  body,
  description,
  title,
}: {
  body: string
  description: string
  title: string
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="icon" href="https://app.tegy.io/favicon.svg" />
    <style>
      :root {
        --bg: #f6f5f2;
        --surface: #ffffff;
        --surface-soft: #fbfaf8;
        --border: #d8d2ca;
        --text: #24211f;
        --muted: #6d6660;
        --green: #1f883d;
        --green-soft: #dafbe1;
        --yellow: #9a6700;
        --yellow-soft: #fff8c5;
        --red: #cf222e;
        --red-soft: #ffebe9;
        --gray: #8c959f;
        --gray-soft: #eaeef2;
        --shadow: 0 12px 32px rgb(31 35 40 / 8%);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.45;
      }

      a { color: inherit; }

      .hero {
        width: min(1040px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 24px 0 0;
      }

      .hero.compact { padding-bottom: 0; }

      .nav {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
      }

      .brand {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        color: var(--text);
        font-size: 20px;
        font-weight: 700;
        text-decoration: none;
      }

      .brand img {
        width: 28px;
        height: 28px;
      }

      .links {
        display: flex;
        gap: 16px;
        color: var(--muted);
        font-size: 14px;
      }

      .links a { text-decoration: none; }
      .links a:hover { text-decoration: underline; }

      .banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        margin-top: 36px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface);
        padding: 22px 24px;
        box-shadow: var(--shadow);
      }

      .banner h1 {
        margin: 3px 0 0;
        font-size: clamp(28px, 5vw, 46px);
        line-height: 1.05;
      }

      .banner-ok { border-color: #95d5a6; }
      .banner-alert { border-color: #f0ad4e; }

      .eyebrow {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
        font-weight: 700;
        text-transform: uppercase;
      }

      .status-dot {
        width: 18px;
        height: 18px;
        border-radius: 999px;
        flex: 0 0 auto;
      }

      .dot-ok { background: var(--green); box-shadow: 0 0 0 8px var(--green-soft); }
      .dot-alert { background: var(--yellow); box-shadow: 0 0 0 8px var(--yellow-soft); }

      main {
        width: min(1040px, calc(100vw - 32px));
        margin: 22px auto 0;
      }

      .panel {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }

      .panel + .panel { margin-top: 18px; }

      .panel-heading {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        border-bottom: 1px solid var(--border);
        padding: 18px 20px;
      }

      .panel-heading h2 {
        margin: 0;
        font-size: 18px;
      }

      .panel-heading p,
      .panel-heading span {
        margin: 2px 0 0;
        color: var(--muted);
        font-size: 14px;
      }

      .component {
        padding: 18px 20px;
      }

      .component + .component {
        border-top: 1px solid var(--border);
      }

      .component-top {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: start;
        gap: 16px;
        margin-bottom: 14px;
      }

      .component h3 {
        margin: 0;
        font-size: 17px;
      }

      .component h3 a {
        text-decoration: none;
      }

      .component h3 a:hover {
        text-decoration: underline;
      }

      .component p {
        margin: 2px 0 0;
        color: var(--muted);
        font-size: 13px;
        overflow-wrap: anywhere;
      }

      .metrics {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: 8px;
        color: var(--muted);
        font-size: 13px;
        text-align: right;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        border-radius: 999px;
        padding: 2px 10px;
        font-weight: 700;
      }

      .pill-ok { background: var(--green-soft); color: var(--green); }
      .pill-alert { background: var(--yellow-soft); color: var(--yellow); }
      .pill-down { background: var(--red-soft); color: var(--red); }
      .pill-unknown { background: var(--gray-soft); color: var(--gray); }

      .uptime-bars {
        display: grid;
        grid-template-columns: repeat(${historyDays}, minmax(2px, 1fr));
        gap: 3px;
        min-height: 38px;
        align-items: stretch;
      }

      .bar {
        display: block;
        min-width: 2px;
        border-radius: 2px;
      }

      .bar-up { background: var(--green); }
      .bar-degraded,
      .bar-not_configured,
      .bar-stale { background: var(--yellow); }
      .bar-down { background: var(--red); }
      .bar-unknown { background: #d0d7de; }

      .axis {
        display: flex;
        justify-content: space-between;
        margin-top: 8px;
        color: var(--muted);
        font-size: 12px;
      }

      .empty {
        padding: 26px 20px;
        color: var(--muted);
      }

      .incident-list {
        margin: 0;
        padding: 12px 20px 20px 40px;
      }

      .incident-list li + li { margin-top: 10px; }
      .incident-list span { color: var(--muted); margin-left: 8px; }

      .detail {
        padding: 22px 24px;
      }

      .detail h1 {
        margin: 4px 0 4px;
        font-size: clamp(30px, 5vw, 48px);
        line-height: 1.05;
      }

      .detail > p:not(.eyebrow) {
        color: var(--muted);
        margin: 0 0 18px;
      }

      .detail-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        margin: 20px 0;
      }

      .detail-grid div {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface-soft);
        padding: 12px;
      }

      .detail-grid span {
        display: block;
        color: var(--muted);
        font-size: 12px;
      }

      .detail-grid strong {
        display: block;
        margin-top: 4px;
        font-size: 15px;
      }

      .uptime-large .uptime-bars { min-height: 72px; }

      .error {
        margin: 18px 0 0;
        border: 1px solid var(--red-soft);
        border-radius: 8px;
        background: #fff8f7;
        color: var(--red);
        padding: 12px;
        white-space: pre-wrap;
      }

      .sample-diagnostics {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin: 18px 0 0;
      }

      .sample-diagnostics div {
        min-width: 0;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface-soft);
        padding: 10px 12px;
      }

      .sample-diagnostics dt {
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }

      .sample-diagnostics dd {
        margin: 4px 0 0;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      footer {
        width: min(1040px, calc(100vw - 32px));
        margin: 24px auto;
        display: flex;
        justify-content: space-between;
        gap: 16px;
        color: var(--muted);
        font-size: 13px;
      }

      @media (max-width: 760px) {
        .nav,
        .panel-heading,
        footer {
          align-items: flex-start;
          flex-direction: column;
        }

        .component-top {
          grid-template-columns: 1fr;
        }

        .metrics {
          justify-content: flex-start;
          text-align: left;
        }

        .detail-grid {
          grid-template-columns: 1fr 1fr;
        }
      }

      @media (max-width: 480px) {
        .links {
          flex-wrap: wrap;
        }

        .banner {
          align-items: flex-start;
          flex-direction: column;
        }

        .detail-grid {
          grid-template-columns: 1fr;
        }

        .sample-diagnostics {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>${body}</body>
</html>`
}

function renderNotFound() {
  return pageShell({
    body: `
      <main>
        <section class="panel detail">
          <p class="eyebrow">404</p>
          <h1>Not Found</h1>
          <p>The requested status page does not exist.</p>
        </section>
      </main>
    `,
    description: "Status page not found.",
    title: "Not Found - Tegy Status",
  })
}

function titleForGlobalStatus(status: CheckStatus) {
  if (status === "up") return "All Systems Operational"
  if (status === "down") return "Service Disruption"
  return "Monitoring Attention Required"
}

function labelStatus(status: CheckStatus) {
  switch (status) {
    case "up":
      return "Up"
    case "degraded":
      return "Degraded"
    case "down":
      return "Down"
    case "not_configured":
      return "Not configured"
    case "stale":
      return "Stale"
    default:
      return "Unknown"
  }
}

function pillClass(status: CheckStatus) {
  if (status === "up") return "pill-ok"
  if (status === "down") return "pill-down"
  if (status === "unknown") return "pill-unknown"
  return "pill-alert"
}

function formatResponseTime(value: number | null) {
  return typeof value === "number" ? `${value} ms` : "No data"
}

function formatPercent(value: number | null) {
  return typeof value === "number" ? `${value.toFixed(2)}%` : "No data"
}

function formatMaybeDate(value: string | null) {
  if (!value) return "No data"
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return "No data"
  return new Date(timestamp).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  })
}

function formatDay(day: DaySummary) {
  if (day.state === "unknown") return "No samples"
  if (day.uptimePercent === null) return labelStatus(day.state)
  return `${labelStatus(day.state)} (${day.uptimePercent.toFixed(0)}% uptime)`
}

async function waitForVisibleWithHeartbeat({
  locator,
  page,
  timeoutMs,
}: {
  locator: Locator
  page: Page
  timeoutMs: number
}) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now()

    try {
      await locator.waitFor({
        timeout: Math.min(syntheticWaitHeartbeatMs, remainingMs),
      })
      return
    } catch (error) {
      lastError = error

      if (!isTimeoutError(error)) {
        throw error
      }

      await page.title().catch(() => undefined)
    }
  }

  throw lastError ?? new Error("Timed out waiting for locator.")
}

function failedSample(
  error: string,
  responseTimeMs: number | null = null,
  details: Partial<CheckSample> = {},
): CheckSample {
  return {
    ...details,
    checkedAt: new Date().toISOString(),
    error,
    responseTimeMs,
    status: "down" as const,
  }
}

function isTimeoutError(error: unknown) {
  const message = errorMessage(error).toLowerCase()

  return message.includes("timeout") || message.includes("timed out")
}

function safePageUrl(page: Page, fallback?: string) {
  try {
    return page.url()
  } catch {
    return fallback
  }
}

function trimDiagnostics(values: string[]) {
  return values.slice(-5)
}

function selectPhrase(date: Date) {
  const index = Math.floor(date.getTime() / promptIntervalMs) % phrases.length
  return phrases[index]
}

function extractMagicLink(raw: string) {
  const normalized = raw
    .replace(/=\r?\n/g, "")
    .replace(/=3D/gi, "=")
    .replace(/&amp;/g, "&")

  const match = normalized.match(
    /https:\/\/app\.tegy\.io\/api\/auth\/magic-link\/verify\?token=[^\s"'<>]+/i,
  )

  return match ? match[0] : null
}

function isAuthorized(request: Request, token: string | undefined) {
  if (!token) return false
  return request.headers.get("Authorization") === `Bearer ${token}`
}

function keyForMagicLink(email: string) {
  return `latest:${email}`
}

function componentKey(slug: string) {
  return `component:${slug}`
}

function alertKey(slug: string) {
  return `alert:${slug}`
}

function normalizeEmail(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "")
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function html(body: string, status = 200) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
    status,
  })
}

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  })
}
