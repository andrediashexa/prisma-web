import { expect, test } from "@playwright/test"

import { linesRouterId, routerId } from "./helpers"

// The rest of the screens and the probes (Prisma 0.150.6, #64).

test("the routing tab shows OSPF interfaces with the MTU mismatch, IS-IS circuits and FRR logging", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/routing`)
  const ospf = page.locator('[data-screen="ospf-interfaces"]')
  await expect(ospf.locator('tr[data-interface="wan0"]')).toContainText("MTU mismatch")
  await expect(page.locator('[data-screen="isis-interfaces"]')).toContainText("lan0")
  await expect(page.locator('[data-screen="routing-logging"]')).toContainText("bgpd")
})

test("the interfaces tab shows the hardware and offers the SNMP files", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/interfaces`)
  await expect(page.locator('[data-screen="hardware"]')).toContainText("default route")
  const download = page.waitForEvent("download")
  await page.locator("[data-snmp-files]").getByRole("link", { name: "MIB" }).click()
  expect((await download).suggestedFilename()).toBe("PRISMA-MIB.txt")
})

test("a ping from the console streams its replies and its summary", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/console`)
  const panel = page.locator("[data-probe]")
  await panel.getByLabel("Host").fill("192.0.2.1")
  await panel.getByLabel("Count").fill("3")
  await panel.getByRole("button", { name: "Run" }).click()
  await expect(panel.locator("[data-probe-lines]")).toContainText("icmp_seq=3")
  await expect(panel.locator("[data-probe-end]")).toContainText("3 of 3 answered")
})

test("a router before 0.150.6 has none of them", async ({ page }) => {
  await page.goto(`/routers/${linesRouterId()}/routing`)
  await expect(page.getByText("OSPF / OSPFv3 neighbors")).toBeVisible()
  await expect(page.locator('[data-screen="ospf-interfaces"]')).toHaveCount(0)
  await page.goto(`/routers/${linesRouterId()}/console`)
  await expect(page.locator("[data-probe]")).toHaveCount(0)
})
