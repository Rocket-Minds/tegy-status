export type CheckStatus =
  | "up"
  | "degraded"
  | "down"
  | "not_configured"
  | "stale"
  | "unknown"

export type ComponentKind = "http" | "browser"

export type ComponentDefinition = {
  description: string
  kind: ComponentKind
  name: string
  slug: string
  url: string
}

export type CheckSample = {
  chatUrl?: string
  checkedAt: string
  consoleMessages?: string[]
  currentUrl?: string
  error?: string
  failedNetworkResponses?: FailedNetworkResponse[]
  phase?: string
  phrase?: string
  responseTimeMs: number | null
  status: CheckStatus
}

export type FailedNetworkResponse = {
  method: string
  preview?: string
  status: number
  statusText: string
  url: string
}

export type StoredComponent = ComponentDefinition & {
  samples: CheckSample[]
  updatedAt: string
}

export type AlertState = {
  lastAlertAt?: string
  lastStatus?: CheckStatus
}

const staleAfterMs = 90 * 60 * 1000

export function classifySample(
  definition: ComponentDefinition,
  existing: StoredComponent,
  sample: CheckSample,
): CheckSample {
  if (sample.status !== "down") {
    return sample
  }

  if (!["browser", "http"].includes(definition.kind)) {
    return sample
  }

  const previousStatus = deriveCurrentStatus(existing.samples.at(-1))

  return {
    ...sample,
    status: ["down", "degraded"].includes(previousStatus) ? "down" : "degraded",
  }
}

export function deriveCurrentStatus(
  sample: CheckSample | null | undefined,
): CheckStatus {
  if (!sample) return "unknown"
  if (Date.now() - Date.parse(sample.checkedAt) > staleAfterMs) return "stale"
  return sample.status
}

export function labelStatus(status: CheckStatus) {
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

export function buildDiscordWebhookPayload(
  definition: ComponentDefinition,
  sample: CheckSample,
) {
  const currentStatus = sample.status
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

  if (sample.failedNetworkResponses?.length) {
    fields.push({
      name: "Failed Requests",
      value: truncate(formatFailedNetworkResponses(sample.failedNetworkResponses), 900),
      inline: false,
    })
  }

  return {
    content,
    embeds: [
      {
        color: colorForStatus(currentStatus),
        fields,
        footer: { text: "status.tegy.io" },
        timestamp: sample.checkedAt,
        title:
          currentStatus === "up"
            ? `${definition.name} recovered`
            : `${definition.name} ${labelStatus(currentStatus)}`,
        url: "https://status.tegy.io",
      },
    ],
  }
}

export function formatFailedNetworkResponses(responses: FailedNetworkResponse[]) {
  return responses
    .map((response) =>
      [
        `${response.method} ${response.url} -> ${response.status}${
          response.statusText ? ` ${response.statusText}` : ""
        }`,
        response.preview ? `Preview: ${response.preview}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n")
}

function colorForStatus(status: CheckStatus) {
  if (status === "up") return 0x1f883d
  if (status === "down") return 0xcf222e
  return 0x9a6700
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value
}
