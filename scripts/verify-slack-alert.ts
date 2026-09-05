import {
  buildSlackVerificationPayload,
} from "../worker/status-core.ts"

declare const process: { env: Record<string, string | undefined> }

const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim()

if (!webhookUrl) {
  throw new Error("SLACK_WEBHOOK_URL is required.")
}

const response = await fetch(webhookUrl, {
  body: JSON.stringify(buildSlackVerificationPayload(new Date().toISOString())),
  headers: { "Content-Type": "application/json" },
  method: "POST",
})

if (!response.ok) {
  throw new Error(`Slack verification failed with HTTP ${response.status}.`)
}

console.log("Verified Tegy status alert delivery to Slack #alerts.")
