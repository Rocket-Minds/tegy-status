import {
  buildDiscordWebhookPayload,
  classifySample,
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

await testHttpTimeoutRequiresConsecutiveFailure()
await testDiscordAlertDoesNotDuplicateContentAndTitle()

console.log("Status worker tests passed.")
