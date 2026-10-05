import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

// Prisma 0.151.5 (#70): a card missing at boot left part of the saved configuration out.
test("a configuration partially applied at boot shows on the router page and can be given up", async ({ page }) => {
  const id = routerId()
  await page.goto(`/routers/${id}`)
  const banner = page.locator("[data-pending-configuration]")
  await expect(banner).toHaveCount(0)
  await page.request.post(`/api/routers/${id}/show`, { data: { command: "mock pending on" } })
  try {
    // The fleet monitor (5 s) picks up the health, then the page reads the screen.
    await expect(banner.getByText(/card wan9 missing/)).toBeVisible({ timeout: 20_000 })
    await expect(banner.getByText(/Saving is refused/)).toBeVisible()
    await banner.getByText(/The statements left out/).click()
    await expect(banner.getByText(/cgnat outside/)).toBeVisible()
    await banner.getByRole("button", { name: "Give them up the statements the boot left out" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText(/the card's configuration is lost/)).toBeVisible()
    await dialog.getByRole("button", { name: "Clear", exact: true }).click()
    await expect(page.getByText("Done: clear configuration pending")).toBeVisible()
    await expect(banner).toHaveCount(0, { timeout: 20_000 })
  } finally {
    await page.request.post(`/api/routers/${id}/show`, { data: { command: "mock pending off" } })
  }
})
