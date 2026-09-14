import type { Page } from "@cloudflare/playwright"

// Only for the dedicated synthetic identity, never an operator's browser.
export async function waitForComposer(page: Page, setPhase: (phase: string) => void) {
  const composer = page.getByTestId("new-chat-composer-prompt")
  const terms = page.getByTestId("terms-acceptance-dialog")

  setPhase("await-workspace")
  await composer.or(terms).first().waitFor()

  if (await terms.isVisible()) {
    setPhase("accept-terms")
    await terms.getByRole("checkbox", { name: /I agree to the Tegy/ }).check()
    await terms.getByRole("button", { name: "Continue", exact: true }).click()
    setPhase("await-terms-acceptance")
    try {
      await terms.waitFor({ state: "hidden" })
    } catch {
      throw new Error("Terms acceptance did not complete. The chat workspace was not reached.")
    }
  }

  setPhase("await-composer")
  await composer.waitFor()
  return composer
}
