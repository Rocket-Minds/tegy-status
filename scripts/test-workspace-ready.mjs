import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium } from "playwright"
import { waitForComposer } from "../worker/workspace-ready.ts"

let browser
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true })
})
after(async () => { await browser?.close() })

const composerHtml = '<textarea data-testid="new-chat-composer-prompt"></textarea>'
const termsHtml = `<section role="dialog" data-testid="terms-acceptance-dialog">
  <label><input type="checkbox">I agree to the Tegy Terms of Service</label>
  <button disabled>Continue</button>
</section>`

async function fixture(t, { accepted = false, delay = 0, save = true, showComposer = true } = {}) {
  const page = await browser.newPage()
  t.after(() => page.close())
  page.setDefaultTimeout(1_500)
  let saves = 0
  await page.route("https://tegy.test/api/auth/terms", async route => {
    saves++
    await route.fulfill({ status: save ? 200 : 500, json: { ok: save } })
  })
  await page.route("https://tegy.test/new", route => route.fulfill({
    contentType: "text/html", body: `<!doctype html><body><script>
      setTimeout(() => {
        document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(accepted ? composerHtml : termsHtml)});
        const checkbox = document.querySelector('input');
        if (!checkbox) return;
        const button = document.querySelector('button');
        checkbox.onchange = () => { button.disabled = !checkbox.checked; };
        button.onclick = async () => {
          const result = await fetch('/api/auth/terms', {method: 'POST'});
          if (!result.ok) return;
          document.querySelector('section').remove();
          if (${showComposer}) document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(composerHtml)});
        };
      }, ${delay});
    </script></body>`,
  }))
  await page.goto("https://tegy.test/new")
  return { page, saves: () => saves }
}

test("already accepted accounts reach the composer without another acceptance", async t => {
  const { page, saves } = await fixture(t, { accepted: true })
  const phases = []
  const composer = await waitForComposer(page, phase => phases.push(phase))
  await composer.fill("Reply with exactly: silver comet")
  assert.equal(saves(), 0)
  assert.deepEqual(phases, ["await-workspace", "await-composer"])
})

test("a terms dialog that appears after boot is accepted once", async t => {
  const { page, saves } = await fixture(t, { delay: 200 })
  const phases = []
  await waitForComposer(page, phase => phases.push(phase))
  assert.equal(saves(), 1)
  assert.deepEqual(phases, ["await-workspace", "accept-terms", "await-terms-acceptance", "await-composer"])
  await waitForComposer(page, () => {})
  assert.equal(saves(), 1)
})

test("a failed terms save fails at acceptance, not at composer submission", async t => {
  const { page, saves } = await fixture(t, { save: false })
  let phase
  await assert.rejects(waitForComposer(page, next => { phase = next }), /Terms acceptance did not complete/)
  assert.equal(phase, "await-terms-acceptance")
  assert.equal(saves(), 1)
  assert.equal(await page.getByTestId("new-chat-composer-prompt").count(), 0)
})

test("acceptance alone is not proof that the composer works", async t => {
  const { page } = await fixture(t, { showComposer: false })
  let phase
  await assert.rejects(waitForComposer(page, next => { phase = next }))
  assert.equal(phase, "await-composer")
})

test("other access screens are not accepted or treated as success", async t => {
  const page = await browser.newPage()
  t.after(() => page.close())
  page.setDefaultTimeout(300)
  await page.setContent("<h1>Access ended</h1><button>Continue</button>")
  let phase
  await assert.rejects(waitForComposer(page, next => { phase = next }))
  assert.equal(phase, "await-workspace")
})
