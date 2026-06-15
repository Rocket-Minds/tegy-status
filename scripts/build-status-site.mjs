import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "site-dist");
const SUMMARY_PATH = path.join(ROOT, "history", "summary.json");
const SYNTHETIC_STATUS_PATH = path.join(
  ROOT,
  "history",
  "tegy-chat-user-journey.json",
);
const DAYS = 90;

const summary = JSON.parse(await readFile(SUMMARY_PATH, "utf8"));
const generatedAt = new Date();

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(path.join(OUT_DIR, "history"), { recursive: true });

const uptimeComponents = await Promise.all(
  summary.map(async (site) => ({
    ...site,
    kind: "upptime",
    history: await readHistory(site.slug),
    days: buildDays(site.dailyMinutesDown ?? {}),
  })),
);
const syntheticComponent = await readSyntheticStatus();
const components = syntheticComponent
  ? [...uptimeComponents, syntheticComponent]
  : uptimeComponents;

const allOperational = components.every(
  (component) => component.status === "up",
);
const anyDegraded = components.some((component) =>
  ["degraded", "not_configured", "stale"].includes(component.status) ||
  component.days.some((day) => ["degraded", "unknown"].includes(day.state)),
);
const anyDown = components.some(
  (component) =>
    component.status === "down" ||
    component.days.some((day) => day.state === "down"),
);

await writeFile(path.join(OUT_DIR, "index.html"), renderIndex(), "utf8");
await writeFile(path.join(OUT_DIR, "CNAME"), "status.tegy.io\n", "utf8");
await writeFile(
  path.join(OUT_DIR, "robots.txt"),
  "User-agent: *\nAllow: /\n",
  "utf8",
);
await writeFile(
  path.join(OUT_DIR, "summary.json"),
  JSON.stringify({ generatedAt: generatedAt.toISOString(), components }, null, 2),
  "utf8",
);

for (const component of components) {
  const dir = path.join(OUT_DIR, "history", component.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "index.html"),
    renderHistory(component),
    "utf8",
  );
}

console.log(`Built status site with ${components.length} components.`);

async function readHistory(slug) {
  const raw = await readFile(path.join(ROOT, "history", `${slug}.yml`), "utf8");
  const data = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    data[match[1]] = match[2].trim();
  }
  return data;
}

async function readSyntheticStatus() {
  let raw;

  try {
    raw = await readFile(SYNTHETIC_STATUS_PATH, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const status = JSON.parse(raw);
  const effectiveStatus = deriveSyntheticStatus(status);
  const days = buildSyntheticDays(status.dailyStates ?? {});

  return {
    ...status,
    kind: "synthetic",
    status: effectiveStatus,
    days,
    uptime: calculateSyntheticUptime(days),
    time: status.responseTimeMs,
    history: {
      lastUpdated: status.lastChecked,
    },
  };
}

function buildDays(dailyMinutesDown) {
  const days = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (let index = DAYS - 1; index >= 0; index -= 1) {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - index);
    const iso = date.toISOString().slice(0, 10);
    const minutesDown = Number(dailyMinutesDown[iso] ?? 0);
    days.push({
      iso,
      label: date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }),
      minutesDown,
      uptimePercent: ((1440 - minutesDown) / 1440) * 100,
      state:
        minutesDown >= 1440
          ? "down"
          : minutesDown > 0
            ? "degraded"
            : "up",
    });
  }
  return days;
}

function buildSyntheticDays(dailyStates) {
  const days = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (let index = DAYS - 1; index >= 0; index -= 1) {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - index);
    const iso = date.toISOString().slice(0, 10);
    const state = normalizeSyntheticDayState(dailyStates[iso]);
    days.push({
      iso,
      label: date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }),
      minutesDown: state === "down" ? 1440 : 0,
      uptimePercent: state === "down" ? 0 : state === "degraded" ? 50 : 100,
      state,
    });
  }

  return days;
}

function renderIndex() {
  const title = allOperational
    ? "All Systems Operational"
    : anyDown
      ? "Service Disruption"
      : anyDegraded
        ? "Monitoring Attention Required"
        : "All Systems Operational";

  return pageShell({
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
            <a href="https://github.com/Rocket-Minds/tegy-status">GitHub</a>
          </div>
        </nav>
        <section class="banner ${allOperational ? "banner-ok" : "banner-alert"}">
          <div>
            <p class="eyebrow">Current Status</p>
            <h1>${escapeHtml(title)}</h1>
          </div>
          <span class="status-dot ${allOperational ? "dot-ok" : "dot-alert"}"></span>
        </section>
      </header>

      <main>
        <section class="panel">
          <div class="panel-heading">
            <div>
              <h2>Current Status: Tegy</h2>
              <p>Uptime and user-journey status over the past ${DAYS} days.</p>
            </div>
            <a href="https://github.com/Rocket-Minds/tegy-status/tree/master/history">View source history</a>
          </div>
          <div class="components">
            ${components.map(renderComponentRow).join("")}
          </div>
        </section>

        <section class="panel incidents">
          <div class="panel-heading">
            <div>
              <h2>Incident History</h2>
              <p>Generated from Upptime history in this repository.</p>
            </div>
          </div>
          ${renderIncidents()}
        </section>
      </main>

      <footer>
        <span>Backed by Upptime, GitHub Actions, and GitHub Pages.</span>
        <span>Last generated ${formatDateTime(generatedAt)} UTC.</span>
      </footer>
    `,
  });
}

function renderHistory(component) {
  return pageShell({
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
            <a href="https://github.com/Rocket-Minds/tegy-status/blob/master/history/${encodeURIComponent(component.slug)}.yml">History file</a>
          </div>
        </nav>
      </header>
      <main>
        <section class="panel detail">
          <p class="eyebrow">Component</p>
          <h1>${escapeHtml(component.name)}</h1>
          <div class="detail-grid">
            <div><span>Current status</span><strong>${escapeHtml(labelStatus(component.status))}</strong></div>
            <div><span>Overall uptime</span><strong>${escapeHtml(component.uptime)}</strong></div>
            <div><span>Average response</span><strong>${escapeHtml(formatResponseTime(component))}</strong></div>
            <div><span>Last checked</span><strong>${escapeHtml(formatMaybeDate(component.history.lastUpdated))}</strong></div>
          </div>
          ${renderBars(component, "large")}
        </section>
      </main>
      <footer>
        <span>Backed by Upptime, GitHub Actions, and GitHub Pages.</span>
        <span>Last generated ${formatDateTime(generatedAt)} UTC.</span>
      </footer>
    `,
  });
}

function renderComponentRow(component) {
  return `
    <article class="component">
      <div class="component-top">
        <div>
          <h3><a href="/history/${escapeHtml(component.slug)}/">${escapeHtml(component.name)}</a></h3>
          <p>${escapeHtml(component.url)}</p>
          ${component.summary ? `<p>${escapeHtml(component.summary)}</p>` : ""}
        </div>
        <div class="metrics">
          <span class="pill ${pillClass(component.status)}">${escapeHtml(labelStatus(component.status))}</span>
          <span>${escapeHtml(component.uptime)} uptime</span>
          <span>${escapeHtml(formatResponseTime(component))}</span>
        </div>
      </div>
      ${renderBars(component)}
    </article>
  `;
}

function renderBars(component, size = "") {
  return `
    <div class="uptime-wrap ${size === "large" ? "uptime-large" : ""}" aria-label="${escapeHtml(component.name)} ${DAYS}-day uptime history">
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
        <span>${DAYS} days ago</span>
        <span>Today</span>
      </div>
    </div>
  `;
}

function renderIncidents() {
  const incidentDays = [];
  for (const component of components) {
    for (const day of component.days) {
      if (day.minutesDown > 0) {
        incidentDays.push({ component, day });
      } else if (day.state === "degraded") {
        incidentDays.push({ component, day });
      }
    }
  }

  if (incidentDays.length === 0) {
    return `<div class="empty">No incidents reported in the last ${DAYS} days.</div>`;
  }

  return `
    <ol class="incident-list">
      ${incidentDays
        .reverse()
        .map(
          ({ component, day }) => `
            <li>
              <strong>${escapeHtml(day.label)}</strong>
              <span>${escapeHtml(component.name)} had ${escapeHtml(formatDay(day).toLowerCase())}.</span>
            </li>
          `,
        )
        .join("")}
    </ol>
  `;
}

function pageShell({ title, body }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="Tegy service status and uptime history." />
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
        border-radius: 6px;
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
        letter-spacing: 0.04em;
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
        border-radius: 6px;
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

      .panel-heading p {
        margin: 2px 0 0;
        color: var(--muted);
        font-size: 14px;
      }

      .panel-heading a {
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

      .pill-ok {
        background: var(--green-soft);
        color: var(--green);
      }

      .pill-alert {
        background: var(--yellow-soft);
        color: var(--yellow);
      }

      .pill-down {
        background: var(--red-soft);
        color: var(--red);
      }

      .uptime-bars {
        display: grid;
        grid-template-columns: repeat(${DAYS}, minmax(2px, 1fr));
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
      .bar-degraded { background: var(--yellow); }
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
        margin: 4px 0 18px;
        font-size: clamp(30px, 6vw, 48px);
      }

      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        margin-bottom: 22px;
      }

      .detail-grid div {
        border: 1px solid var(--border);
        border-radius: 6px;
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
        margin-top: 3px;
        font-size: 18px;
      }

      .uptime-large .uptime-bars {
        min-height: 90px;
      }

      footer {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        width: min(1040px, calc(100vw - 32px));
        margin: 18px auto 36px;
        color: var(--muted);
        font-size: 13px;
      }

      @media (max-width: 720px) {
        .nav,
        .panel-heading,
        footer {
          align-items: flex-start;
          flex-direction: column;
        }

        .links {
          flex-wrap: wrap;
        }

        .banner {
          margin-top: 26px;
          padding: 18px;
        }

        .component-top {
          grid-template-columns: 1fr;
        }

        .metrics {
          justify-content: flex-start;
          text-align: left;
        }

        .uptime-bars {
          gap: 2px;
        }
      }
    </style>
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

function labelStatus(status) {
  if (status === "up") return "Operational";
  if (status === "down") return "Down";
  if (status === "not_configured") return "Not configured";
  if (status === "stale") return "Stale";
  return "Degraded";
}

function formatDay(day) {
  if (day.state === "unknown") return "No data";
  if (day.state === "degraded") return "Degraded";
  if (day.minutesDown <= 0) return "100% uptime";
  if (day.minutesDown >= 1440) return "full day outage";
  return `${day.minutesDown} minutes down`;
}

function deriveSyntheticStatus(status) {
  if (status.status === "up" && isStale(status.lastChecked)) {
    return "stale";
  }

  return normalizeStatus(status.status);
}

function normalizeStatus(status) {
  if (["up", "down", "degraded", "not_configured", "stale"].includes(status)) {
    return status;
  }

  return "unknown";
}

function normalizeSyntheticDayState(state) {
  if (["up", "down", "degraded"].includes(state)) {
    return state;
  }

  return "unknown";
}

function calculateSyntheticUptime(days) {
  const knownDays = days.filter((day) => day.state !== "unknown");

  if (knownDays.length === 0) {
    return "Pending";
  }

  const upDays = knownDays.filter((day) => day.state === "up").length;
  return `${((upDays / knownDays.length) * 100).toFixed(2)}%`;
}

function isStale(value) {
  if (!value) return false;
  const checkedAt = new Date(value).getTime();
  if (Number.isNaN(checkedAt)) return false;

  return Date.now() - checkedAt > 150 * 60 * 1000;
}

function pillClass(status) {
  if (status === "up") return "pill-ok";
  if (status === "down") return "pill-down";
  return "pill-alert";
}

function formatResponseTime(component) {
  const time = Number(component.time);

  if (!Number.isFinite(time) || time <= 0) {
    return component.kind === "synthetic" ? "No run yet" : "Unknown";
  }

  return component.kind === "synthetic"
    ? `${Math.round(time / 1000)} s run`
    : `${Math.round(time)} ms avg`;
}

function formatMaybeDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date);
}

function formatDateTime(date) {
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
