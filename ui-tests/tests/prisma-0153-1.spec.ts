import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

// Prisma 0.153.1 (#96) on the main mock: one VRRP id with IPv6 addresses is two virtual routers.

test("the HA screen lists a VRRP id once per family", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/cgnat`)
  const card = page.locator("[data-cgnat-diagnostics]")
  await card.getByRole("tab", { name: "HA" }).click()
  const ha = card.locator('[data-screen="ha"]')
  await expect(ha.locator('[data-vr="lan0-10-4"]')).toContainText("IPv4")
  await expect(ha.locator('[data-vr="lan0-10-4"]')).toContainText("192.168.10.254")
  await expect(ha.locator('[data-vr="lan0-10-6"]')).toContainText("IPv6")
  await expect(ha.locator('[data-vr="lan0-10-6"]')).toContainText("fe80::10, 2001:db8:200:10::fe")
})

test("the VRRP page lists both routers of vrid 10", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/routing/vrrp`)
  await expect(page.getByRole("row").filter({ hasText: "IPv6" })).toContainText("fe80::10")
  await expect(page.getByRole("row").filter({ hasText: "IPv4" })).toContainText("192.168.10.254")
})
