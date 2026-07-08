import {
  buildDiscordWebhookPayload,
  classifySample,
  shouldSendDiscordAlert,
  type AlertState,
  type CheckSample,
  type ComponentDefinition,
  type StoredComponent,
} from "../worker/status-core.ts"

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${String(expected)}, got ${String(actual)}.`)
  }
}

function assertNotEqual<T>(actual: T, expected: T, message: string) {
  if (actual === expected) {
    throw new Error(`${message}. Both values were ${String(actual)}.`)
  }
}

function assertOk(value: unknown, message: string) {
  if (!value) {
    throw new Error(message)
  }
}

const marketingDefinition: ComponentDefinition = {
  description: "Public marketing website homepage.",
  kind: "http",
  name: "Tegy marketing site",
  slug: "tegy-marketing-site",
  url: "https://tegy.io/",
}

const browserDefinition: ComponentDefinition = {
  description:
    "Browser login, magic link, composer submit, cached model response, and logout.",
  kind: "browser",
  name: "Tegy chat user journey",
  slug: "tegy-chat-user-journey",
  url: "https://app.tegy.io/new",
}

function storedComponent(
  definition: ComponentDefinition,
  samples: CheckSample[],
): StoredComponent {
  return {
    ...definition,
    samples,
    updatedAt: samples.at(-1)?.checkedAt || new Date(0).toISOString(),
  }
}

function sample(status: CheckSample["status"], error?: string): CheckSample {
  return {
    checkedAt: new Date().toISOString(),
    error,
    responseTimeMs: status === "up" ? 900 : 20_000,
    status,
  }
}

async function testHttpTimeoutRequiresConsecutiveFailure() {
  const firstTimeout = classifySample(
    marketingDefinition,
    storedComponent(marketingDefinition, [sample("up")]),
    sample("down", "Timed out after 20000ms."),
  )

  assertEqual(
    firstTimeout.status,
    "degraded",
    "first HTTP timeout after an up check should be degraded",
  )

  const secondTimeout = classifySample(
    marketingDefinition,
    storedComponent(marketingDefinition, [firstTimeout]),
    sample("down", "Timed out after 20000ms."),
  )

  assertEqual(
    secondTimeout.status,
    "down",
    "consecutive HTTP timeout should become down",
  )
}

async function testDiscordAlertDoesNotDuplicateContentAndTitle() {
  const payload = buildDiscordWebhookPayload(marketingDefinition, {
    ...sample("degraded", "Timed out after 20000ms."),
    checkedAt: "2026-06-20T11:30:22.293Z",
  })

  assertOk(payload.content, "Discord payload should include message content")
  assertOk(payload.embeds?.[0]?.title, "Discord payload should include embed title")
  assertNotEqual(
    payload.embeds?.[0]?.title,
    payload.content,
    "Discord content and embed title should not repeat the exact same alert text",
  )
}

async function testDiscordAlertSuppressesSingleDegradedBrowserRun() {
  const firstFailure = classifySample(
    browserDefinition,
    storedComponent(browserDefinition, [sample("up")]),
    sample(
      "down",
      "locator.waitFor: Target page, context or browser has been closed",
    ),
  )

  assertEqual(
    firstFailure.status,
    "degraded",
    "first browser failure after an up check should be degraded",
  )
  assertEqual(
    shouldSendDiscordAlert({
      alertReminderMs: 3 * 60 * 60 * 1000,
      alertState: { lastStatus: "up" },
      currentStatus: firstFailure.status,
      nowMs: Date.parse(firstFailure.checkedAt),
      previousStatus: "up",
    }),
    false,
    "single degraded browser run should update status history without Discord paging",
  )
  assertEqual(
    shouldSendDiscordAlert({
      alertReminderMs: 3 * 60 * 60 * 1000,
      alertState: { lastStatus: "degraded" },
      currentStatus: "up",
      nowMs: Date.now(),
      previousStatus: "degraded",
    }),
    false,
    "recovery from an unnotified degraded run should not send a recovery page",
  )

  const secondFailure = classifySample(
    browserDefinition,
    storedComponent(browserDefinition, [firstFailure]),
    sample("down", "Timed out waiting for locator."),
  )

  assertEqual(
    secondFailure.status,
    "down",
    "consecutive browser failure should become down",
  )
  assertEqual(
    shouldSendDiscordAlert({
      alertReminderMs: 3 * 60 * 60 * 1000,
      alertState: { lastStatus: "degraded" },
      currentStatus: secondFailure.status,
      nowMs: Date.parse(secondFailure.checkedAt),
      previousStatus: "degraded",
    }),
    true,
    "repeated browser failure should send a Discord page",
  )
  assertEqual(
    shouldSendDiscordAlert({
      alertReminderMs: 3 * 60 * 60 * 1000,
      alertState: { lastNotifiedStatus: "down", lastStatus: "down" },
      currentStatus: "up",
      nowMs: Date.now(),
      previousStatus: "down",
    }),
    true,
    "recovery from a notified down state should send a recovery page",
  )
}

async function testDiscordAlertRecoversLegacyDegradedNotifications() {
  const legacyAlertState: AlertState = {
    lastAlertAt: "2026-07-08T04:01:00.000Z",
    lastStatus: "degraded",
  }

  assertEqual(
    shouldSendDiscordAlert({
      alertReminderMs: 3 * 60 * 60 * 1000,
      alertState: legacyAlertState,
      currentStatus: "up",
      nowMs: Date.parse("2026-07-08T04:31:00.000Z"),
      previousStatus: "degraded",
    }),
    true,
    "legacy degraded alerts should still send one recovery after deploy",
  )
}

await testHttpTimeoutRequiresConsecutiveFailure()
await testDiscordAlertDoesNotDuplicateContentAndTitle()
await testDiscordAlertSuppressesSingleDegradedBrowserRun()
await testDiscordAlertRecoversLegacyDegradedNotifications()

console.log("Status worker tests passed.")
