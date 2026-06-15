type Env = {
  CAPTURE_TOKEN: string
  MAGIC_LINKS: KVNamespace
  SYNTHETIC_EMAIL: string
}

type StoredMagicLink = {
  from: string
  magicLink: string
  receivedAt: string
  subject: string
  to: string
}

const ttlSeconds = 10 * 60

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/health") {
      return json({ ok: true })
    }

    if (url.pathname !== "/magic-link" || request.method !== "GET") {
      return json({ error: "Not found" }, { status: 404 })
    }

    const auth = request.headers.get("Authorization") ?? ""
    if (auth !== `Bearer ${env.CAPTURE_TOKEN}`) {
      return json({ error: "Unauthorized" }, { status: 401 })
    }

    const email = normalizeEmail(url.searchParams.get("email"))
    const since = Date.parse(url.searchParams.get("since") ?? "")

    if (!email || email !== normalizeEmail(env.SYNTHETIC_EMAIL)) {
      return json({ error: "Unknown mailbox" }, { status: 404 })
    }

    const record = await env.MAGIC_LINKS.get<StoredMagicLink>(keyFor(email), {
      type: "json",
    })

    if (!record || (Number.isFinite(since) && Date.parse(record.receivedAt) < since)) {
      return json({ error: "Magic link not found" }, { status: 404 })
    }

    return json(record)
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const to = normalizeEmail(message.to)
    const expectedTo = normalizeEmail(env.SYNTHETIC_EMAIL)

    if (to !== expectedTo) {
      message.setReject(`Unexpected synthetic recipient: ${message.to}`)
      return
    }

    const raw = await new Response(message.raw).text()
    const magicLink = extractMagicLink(raw)

    if (!magicLink) {
      await env.MAGIC_LINKS.put(
        keyFor(to),
        JSON.stringify({
          from: message.from,
          magicLink: "",
          receivedAt: new Date().toISOString(),
          subject: message.headers.get("subject") ?? "",
          to: message.to,
        }),
        { expirationTtl: ttlSeconds },
      )
      return
    }

    await env.MAGIC_LINKS.put(
      keyFor(to),
      JSON.stringify({
        from: message.from,
        magicLink,
        receivedAt: new Date().toISOString(),
        subject: message.headers.get("subject") ?? "",
        to: message.to,
      } satisfies StoredMagicLink),
      { expirationTtl: ttlSeconds },
    )
  },
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

function keyFor(email: string) {
  return `latest:${email}`
}

function normalizeEmail(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
}

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}
