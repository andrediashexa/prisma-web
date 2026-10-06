import { expect, test } from "@playwright/test"

import { linesRouterId, routerId } from "./helpers"

// A port's transceiver (Prisma 0.151.15, #76): the plain mock reports 0.151.15.

test("the Interfaces tab shows each module, a level past its threshold, and no light", async ({ page }) => {
  const R = `/api/routers/${routerId()}`
  try {
    await page.goto(`/routers/${routerId()}/interfaces`)
    const card = page.locator("[data-transceivers]")
    const wan0 = card.locator("[data-transceiver=wan0]")
    await expect(wan0).toContainText("FINISAR CORP.")
    await expect(wan0.locator("[data-rx]")).toContainText("dBm")
    await expect(wan0.locator("[data-rx] [data-tone]")).toHaveAttribute("data-tone", "ok")
    await expect(card.locator("[data-transceiver=lan0] [data-rx] [data-tone]")).toHaveAttribute("data-tone", "warning")
    await expect(card.locator("[data-transceiver=lan2]")).toContainText("the cage is empty")
    await expect(card.locator("[data-transceiver=lan1]")).toContainText("copper")
    await expect(card.getByText("1 past a threshold")).toBeVisible()

    await page.request.post(`${R}/show`, { data: { command: "mock transceiver wan0 rx 0" } })
    await page.reload()
    await expect(wan0.locator("[data-rx]")).toHaveText(/no light/)
    await expect(wan0.locator("[data-rx] [data-tone]")).toHaveAttribute("data-tone", "alarm")
    await expect(card.getByText("2 past a threshold")).toBeVisible()
  } finally {
    await page.request.post(`${R}/show`, { data: { command: "mock transceiver wan0 rx 0.48" } })
  }
})

test("after an upgrade, before the dataplane restarts, the card says why no port is listed", async ({ page }) => {
  const R = `/api/routers/${routerId()}`
  await page.request.post(`${R}/show`, { data: { command: "mock transceivers old-plugin on" } })
  try {
    await page.goto(`/routers/${routerId()}/interfaces`)
    const card = page.locator("[data-transceivers]")
    await expect(card.locator("[data-no-dataplane-ports]")).toContainText("system dataplane restart")
    await expect(card.locator("[data-transceiver=eno1]")).toBeVisible()
    await expect(card.locator("[data-transceiver=wan0]")).toHaveCount(0)
  } finally {
    await page.request.post(`${R}/show`, { data: { command: "mock transceivers old-plugin off" } })
  }
})

test("a router before 0.151.15 shows no transceivers", async ({ page }) => {
  await page.goto(`/routers/${linesRouterId()}/interfaces`)
  await expect(page.getByRole("button", { name: "Edit lan0", exact: true })).toBeVisible()
  await expect(page.locator("[data-transceivers]")).toHaveCount(0)
})
