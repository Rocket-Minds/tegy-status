import {
  buildSlackWebhookPayload,
  type CheckSample,
  type ComponentDefinition,
} from "../worker/status-core.ts"

declare const process: { env: Record<string, string | undefined> }

const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim()

if (!webhookUrl) {
  throw new Error("SLACK_WEBHOOK_URL is required.")
}

const definition: ComponentDefinition = {
  description: "Synthetic verification of the status alert transport.",
  kind: "browser",
  name: "Slack status integration verification",
  slug: "slack-status-integration-verification",
  url: "https://status.tegy.io",
}
const sample: CheckSample = {
  checkedAt: new Date().toISOString(),
  error: "Synthetic verification only. No Tegy component is down.",
  phase: "webhook-verification",
  responseTimeMs: null,
  status: "down",
}
const response = await fetch(webhookUrl, {
  body: JSON.stringify(buildSlackWebhookPayload(definition, sample)),
  headers: { "Content-Type": "application/json" },
  method: "POST",
})

if (!response.ok) {
  throw new Error(`Slack verification failed with HTTP ${response.status}.`)
}

console.log("Verified Tegy status alert delivery to Slack #alerts.")
