// Keep only transport facts. Never retain request bodies, headers, or query strings.
export class SubmissionDiagnostics {
  private attempts: Array<{ status?: number; failed: boolean }> = []
  private requests = new Map<object, { status?: number; failed: boolean }>()

  started(request: object, method: string, url: string) {
    if (method !== "POST" || !/^\/api\/chats\/[0-9a-f-]+\/turns$/.test(new URL(url).pathname)) return
    const attempt = { failed: false }
    this.requests.set(request, attempt)
    this.attempts.push(attempt)
  }

  responded(request: object, status: number) {
    const attempt = this.requests.get(request)
    if (attempt) attempt.status = status
  }

  failed(request: object) {
    const attempt = this.requests.get(request)
    if (attempt) attempt.failed = true
  }

  summary() {
    if (!this.attempts.length) return "The browser did not start the message request."
    return this.attempts.slice(-3).map((attempt, index) => {
      const result = attempt.failed
        ? `Connection failed${attempt.status ? ` after HTTP ${attempt.status}` : " before an HTTP response"}.`
        : attempt.status
          ? `Received HTTP ${attempt.status}; this does not confirm a completed answer.`
          : "Started, but no HTTP response arrived."
      return `Message request ${Math.max(0, this.attempts.length - 3) + index + 1}: ${result}`
    }).join("\n")
  }
}
