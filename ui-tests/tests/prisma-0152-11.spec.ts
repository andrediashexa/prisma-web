import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

// Prisma 0.152.11 (#95) on the main mock: show cgnat ha peer <file>, and the record's host and flap events.

test("the HA screen compares with a peer copy at another path, and says why one cannot be read", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/cgnat`)
  const card = page.locator("[data-cgnat-diagnostics]")
  await card.getByRole("tab", { name: "HA" }).click()
  const ha = card.locator('[data-screen="ha"]')
  await expect(ha.locator("[data-peer-read]")).toHaveAttribute("data-peer-read", "no")

  const path = ha.getByLabel("Peer copy path")
  await path.fill("ha-peer.conf")
  await expect(ha.getByText("an absolute path on the router")).toBeVisible()
  await expect(ha.getByRole("button", { name: "Compare" })).toBeDisabled()

  await path.fill("/var/lib/prisma-routing/ha-peer.conf")
  await ha.getByRole("button", { name: "Compare" }).click()
  await expect(ha.locator("[data-peer-read]")).toHaveAttribute("data-peer-read", "yes")
  await expect(ha).toContainText("Read from")
  await expect(ha).toContainText("/var/lib/prisma-routing/ha-peer.conf")

  await path.fill("/dev/zero")
  await ha.getByRole("button", { name: "Compare" }).click()
  await expect(ha.locator("[data-peer-read]")).toHaveText("/dev/zero is not a regular file")
})

test("the box log shows a card Linux holds and a flap, under the link kind", async ({ page }) => {
  await page.goto(`/routers/${routerId()}`)
  const card = page.locator("[data-box-log]")
  await card.getByRole("combobox", { name: "Kind" }).click()
  await page.getByRole("option", { name: "Links", exact: true }).click()
  await expect(card.getByText("interface eno1 (held by Linux): link went down")).toBeVisible()
  await expect(card.getByText(/interface wan0: link went down and came back between two readings/)).toBeVisible()
})
