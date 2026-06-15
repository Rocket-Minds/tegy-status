import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const ROOT = process.cwd()
const STATUS_PATH = path.join(ROOT, "history", "tegy-chat-user-journey.json")
const RESULT_PATH =
  process.env.TEGY_SYNTHETIC_RESULT_PATH ||
  path.join(ROOT, "synthetics", "artifacts", "result.json")

const configured = process.env.TEGY_SYNTHETIC_CONFIGURED === "true"
const outcome = process.env.TEGY_SYNTHETIC_RUN_OUTCOME || "skipped"
const now = new Date()
const today = now.toISOString().slice(0, 10)

const existing = await readExistingStatus()
const result = await readResult()

let status = "not_configured"
let summary = "Magic-link login, composer submit, model response, and logout are not configured yet."
let responseTimeMs = null
let lastError = null
let phrase = null

if (configured && result) {
  status = result.ok ? "up" : "down"
  summary = result.ok
    ? `Last browser journey completed using cached phrase "${result.phrase}".`
    : "Last browser journey failed."
  responseTimeMs = result.durationMs ?? null
  lastError = result.error ?? null
  phrase = result.phrase ?? null
} else if (configured && outcome === "failure") {
  status = "down"
  summary = "Browser journey failed before writing a result file."
  lastError = "Synthetic workflow failed before result.json was written."
} else if (configured) {
  status = "degraded"
  summary = "Browser journey did not run to completion."
  lastError = `Synthetic workflow outcome: ${outcome}`
}

const dailyStates = {
  ...(existing.dailyStates ?? {}),
  [today]: status === "up" ? "up" : status === "down" ? "down" : "degraded",
}

const next = {
  name: "Tegy chat user journey",
  slug: "tegy-chat-user-journey",
  url: "https://app.tegy.io/new",
  status,
  summary,
  lastChecked: now.toISOString(),
  responseTimeMs,
  lastError,
  phrase,
  runUrl: process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : existing.runUrl ?? null,
  dailyStates,
}

await mkdir(path.dirname(STATUS_PATH), { recursive: true })
await writeFile(STATUS_PATH, `${JSON.stringify(next, null, 2)}\n`)

async function readExistingStatus() {
  try {
    return JSON.parse(await readFile(STATUS_PATH, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {}
    }

    throw error
  }
}

async function readResult() {
  try {
    return JSON.parse(await readFile(RESULT_PATH, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null
    }

    throw error
  }
}
