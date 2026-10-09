import { expect, test } from "@playwright/test"

import { linesRouterId, routerId } from "./helpers"

// BFD sessions, typed and live (Prisma 0.150.10, #66).

test("a BFD session going down shows on the routing tab as it happens", async ({ page }) => {
  const R = `/api/routers/${routerId()}`
  await page.goto(`/routers/${routerId()}/routing/bfd`)
  const card = page.locator('[data-screen="bfd-sessions"]')
  const row = card.locator('tr[data-peer="192.168.10.2"]')
  await expect(row).toContainText("up")
  await expect(card.getByText("live")).toBeVisible()
  try {
    await page.request.post(`${R}/show`, { data: { command: "mock bfd down 192.168.10.2" } })
    await expect(card.locator("[data-bfd-changes]")).toContainText("192.168.10.2 changed: up → down", { timeout: 15_000 })
    await expect(row).toContainText("down")
  } finally {
    await page.request.post(`${R}/show`, { data: { command: "mock bfd up 192.168.10.2" } })
  }
})

test("a router before 0.150.10 has no BFD card", async ({ page }) => {
  await page.goto(`/routers/${linesRouterId()}/routing/bfd`)
  await expect(page.getByRole("navigation", { name: "Routing" })).toBeVisible()
  await expect(page.locator('[data-screen="bfd-sessions"]')).toHaveCount(0)
})
