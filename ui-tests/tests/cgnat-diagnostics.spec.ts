import { expect, test } from "@playwright/test"

import { linesRouterId, routerId } from "./helpers"

// The rest of show cgnat (Prisma 0.150.3, #63) on the CGNAT tab.

test("the diagnostics card looks up who used a public address and shows the screens", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/cgnat`)
  const card = page.locator("[data-cgnat-diagnostics]")
  await expect(card).toBeVisible()
  await card.getByLabel("Public address").fill("203.0.113.70")
  await card.getByLabel("Public port").fill("8443")
  await card.getByRole("button", { name: "Who used it" }).click()
  await expect(card.locator('[data-screen="translation"]')).toContainText("100.64.")
  await card.getByLabel("Public address").fill("192.0.2.1")
  await card.getByRole("button", { name: "Who used it" }).click()
  await expect(card.getByRole("alert")).toContainText("not an outside address")
  await card.getByRole("tab", { name: "Top" }).click()
  await expect(card.locator('[data-screen="top"]')).toContainText("100.64.0.1")
  await card.getByRole("tab", { name: "History" }).click()
  await expect(card.locator('[data-screen="history"]')).toContainText("intact")
})

test("a router before 0.150.3 has no diagnostics card", async ({ page }) => {
  await page.goto(`/routers/${linesRouterId()}/cgnat`)
  await expect(page.getByText("Look up subscriber")).toBeVisible()
  await expect(page.locator("[data-cgnat-diagnostics]")).toHaveCount(0)
})
