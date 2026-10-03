import { expect, test } from "@playwright/test"

import { linesRouterId, routerId } from "./helpers"

// The CGNAT log, live (Prisma 0.149.25, #49): WatchLogging through Server-Sent Events.

test("a subscriber's allocations arrive while the watch runs, and Stop ends it", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/cgnat`)
  const panel = page.locator("[data-live-log]")
  await panel.getByLabel("Subscriber").fill("100.64.5.5")
  await panel.getByRole("button", { name: "Watch" }).click()
  // Events show while the stream is open: nothing on the way holds them back.
  await expect(panel.locator('tr[data-kind="STARTED"]')).toBeVisible()
  await expect(panel.locator('tr[data-kind="ALLOC"]').first()).toContainText("100.64.5.5")
  await expect(panel.locator('tr[data-kind="RELEASE"]').first()).toContainText("100.64.5.5")
  await panel.getByRole("button", { name: "Stop" }).click()
  await expect(panel.getByRole("button", { name: "Watch" })).toBeVisible()
  const rows = await panel.locator("tbody tr").count()
  await page.waitForTimeout(1500)
  await expect(panel.locator("tbody tr")).toHaveCount(rows)
})

test("a wrong filter is shown in the panel, in words", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/cgnat`)
  const panel = page.locator("[data-live-log]")
  await panel.getByLabel("Public address").fill("not-an-address")
  await panel.getByRole("button", { name: "Watch" }).click()
  await expect(panel.getByRole("alert")).toContainText("is not a public address")
})

test("a router before 0.149.25 has no live log", async ({ page }) => {
  await page.goto(`/routers/${linesRouterId()}/cgnat`)
  await expect(page.getByText("Look up subscriber")).toBeVisible()
  await expect(page.locator("[data-live-log]")).toHaveCount(0)
})
