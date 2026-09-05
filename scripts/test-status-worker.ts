import {
  buildSlackWebhookPayload,
  classifySample,
  shouldSendSlackAlert,
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

async function testSlackAlertPreservesFallbackAndBlockDetails() {
  const payload = buildSlackWebhookPayload(marketingDefinition, {
    ...sample("degraded", "Timed out after 20000ms."),
    checkedAt: "2026-06-20T11:30:22.293Z",
  })

  assertOk(payload.text, "Slack payload should include fallback text")
  assertEqual(
    payload.attachments[0]?.color,
    "#9a6700",
    "Slack payload should preserve status color",
  )
  const blocks = JSON.stringify(payload.attachments[0]?.blocks)
  assertOk(blocks.includes("Tegy marketing site Degraded"), "Slack blocks should include the alert title")
  assertOk(blocks.includes("status.tegy.io"), "Slack blocks should link to the status page")
  assertOk(blocks.includes("Timed out after 20000ms."), "Slack blocks should include diagnostics")
}

async function testSlackAlertSendsOnFirstDegradedBrowserRun() {
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
    shouldSendSlackAlert({
      alertReminderMs: 3 * 60 * 60 * 1000,
      alertState: { lastStatus: "up" },
      currentStatus: firstFailure.status,
      notifyOnDegraded: true,
      nowMs: Date.parse(firstFailure.checkedAt),
      previousStatus: "up",
    }),
    true,
    "the first degraded browser run should warn Slack",
  )
  assertEqual(
    shouldSendSlackAlert({
      alertReminderMs: 3 * 60 * 60 * 1000,
      alertState: {
        lastAlertAt: firstFailure.checkedAt,
        lastNotifiedStatus: "degraded",
        lastStatus: "degraded",
      },
      currentStatus: "up",
      notifyOnDegraded: true,
      nowMs: Date.now(),
      previousStatus: "degraded",
    }),
    true,
    "recovery from a notified degraded browser run should send a recovery",
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
    shouldSendSlackAlert({
      alertReminderMs: 3 * 60 * 60 * 1000,
      alertState: {
        lastAlertAt: firstFailure.checkedAt,
        lastNotifiedStatus: "degraded",
        lastStatus: "degraded",
      },
      currentStatus: secondFailure.status,
      notifyOnDegraded: true,
      nowMs: Date.parse(secondFailure.checkedAt),
      previousStatus: "degraded",
    }),
    true,
    "repeated browser failure should send a Slack page",
  )
  assertEqual(
    shouldSendSlackAlert({
      alertReminderMs: 3 * 60 * 60 * 1000,
      alertState: { lastNotifiedStatus: "down", lastStatus: "down" },
      currentStatus: "up",
      notifyOnDegraded: true,
      nowMs: Date.now(),
      previousStatus: "down",
    }),
    true,
    "recovery from a notified down state should send a recovery page",
  )
}

async function testSlackAlertKeepsHttpFirstFailureDebounce() {
  const firstFailure = classifySample(
    marketingDefinition,
    storedComponent(marketingDefinition, [sample("up")]),
    sample("down", "Timed out after 20000ms."),
  )

  assertEqual(
    shouldSendSlackAlert({
      alertReminderMs: 3 * 60 * 60 * 1000,
      alertState: { lastStatus: "up" },
      currentStatus: firstFailure.status,
      notifyOnDegraded: false,
      nowMs: Date.parse(firstFailure.checkedAt),
      previousStatus: "up",
    }),
    false,
    "the first degraded HTTP check should remain debounced",
  )
}

async function testSlackAlertRecoversLegacyDegradedNotifications() {
  const legacyAlertState: AlertState = {
    lastAlertAt: "2026-07-08T04:01:00.000Z",
    lastStatus: "degraded",
  }

  assertEqual(
    shouldSendSlackAlert({
      alertReminderMs: 3 * 60 * 60 * 1000,
      alertState: legacyAlertState,
      currentStatus: "up",
      notifyOnDegraded: true,
      nowMs: Date.parse("2026-07-08T04:31:00.000Z"),
      previousStatus: "degraded",
    }),
    true,
    "legacy degraded alerts should still send one recovery after deploy",
  )
}

await testHttpTimeoutRequiresConsecutiveFailure()
await testSlackAlertPreservesFallbackAndBlockDetails()
await testSlackAlertSendsOnFirstDegradedBrowserRun()
await testSlackAlertKeepsHttpFirstFailureDebounce()
await testSlackAlertRecoversLegacyDegradedNotifications()

console.log("Status worker tests passed.")
