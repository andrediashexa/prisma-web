import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

// CPUs and RAM by plane (#81): the mock's layout is control plane 0-1, main 2, workers 3-7, with
// 32 GiB of RAM and 16 GiB of hugepages.
test("the Resources card shows each plane's CPUs and RAM, and the router's own screens", async ({ page }) => {
  await page.goto(`/routers/${routerId()}`)
  const card = page.locator("[data-resources]")
  await expect(card.locator("[data-cpu-total]")).toHaveText("8 logical CPUs in use")
  await expect(card.locator("[data-plane=control]")).toContainText("2 CPUs")
  await expect(card.locator("[data-plane=control]")).toContainText("CPU 0-1")
  await expect(card.locator("[data-plane=main]")).toContainText("1 CPU")
  await expect(card.locator("[data-plane=workers]")).toContainText("5 CPUs")
  await expect(card.locator("[data-plane=workers]")).toContainText("CPU 3-7")
  await expect(card.locator("[data-plane=dataplane-memory]")).toContainText("16")
  await expect(card.locator("[data-resources-memory]")).toContainText("32")
  // The mock is on 0.152.9: it reports its processors, so no note (cpu-usage.spec.ts).
  await expect(card.locator("[data-not-reported]")).toHaveCount(0)
  await card.getByText("The router's CPU layout (show system cpu)").click()
  await expect(card.locator("pre").first()).toBeVisible()
})
