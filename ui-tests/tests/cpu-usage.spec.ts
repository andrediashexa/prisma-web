import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

// Each core's load (#87). The mock (0.152.9) has 2 sockets × 4 cores; control 0-1, main 2, workers 3-7.

test("the Resources card shows the processors the router reports, and each map tile its socket and core", async ({ page }) => {
  await page.goto(`/routers/${routerId()}`)
  const card = page.locator("[data-resources]")
  const topo = card.locator("[data-resources-topology]")
  await expect(topo.locator("[data-cpu-model]")).toContainText("Xeon")
  await expect(topo.locator("[data-topology=sockets]")).toContainText("2")
  await expect(topo.locator("[data-topology=cores]")).toContainText("8")
  await expect(topo.locator("[data-topology=numa]")).toContainText("2")
  await expect(card.locator("[data-not-reported]")).toHaveCount(0)
  await card.getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "Map" }).click()
  await expect(card.locator("[data-cpu='5'] [data-cpu-where]")).toHaveText("s1·c1")
})

test("the CPU usage card shows each core now and over time, as lines or a heatmap, over the range chosen", async ({ page }) => {
  await page.goto(`/routers/${routerId()}`)
  const card = page.locator("[data-cpu-usage]")
  const now = card.locator("[data-cpu-now]")
  await expect(now.locator("[data-cpu]")).toHaveCount(8)
  await expect(now.locator("[data-cpu-plane=worker]")).toHaveCount(5)
  await expect(now.locator("[data-cpu='3']")).toContainText("VPP load")
  await expect(now.locator("[data-cpu='1']")).toContainText("steal")
  await expect(card.locator("[data-cpu-lines] .recharts-line")).toHaveCount(8)

  await card.getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "Heatmap" }).click()
  await expect(card).toHaveAttribute("data-view", "heatmap")
  await expect(card.locator("[data-heat-cpu]")).toHaveCount(8)

  const req = page.waitForRequest((r) => r.url().includes("/cpu-history?minutes=1440"))
  await card.getByRole("radiogroup", { name: "Range" }).getByRole("radio", { name: "24 h" }).click()
  await req
  await expect(card.locator("[data-heat-cpu]")).toHaveCount(8)
})

test("the home dashboard takes a CPU usage widget, its view and range chosen when added", async ({ page }) => {
  const name = (await (await page.request.get("/api/routers")).json()).find((r: { id: string }) => r.id === routerId()).name
  await page.request.delete("/api/dashboard")
  try {
    await page.goto("/")
    await page.getByRole("button", { name: "Customize" }).click()
    await page.getByRole("button", { name: "Add widget" }).first().click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("button", { name: /CPU usage per core/ }).click()
    await dialog.getByRole("combobox").first().click()
    await page.getByRole("option", { name, exact: true }).click()
    await dialog.getByRole("combobox", { name: "View" }).click()
    await page.getByRole("option", { name: "Heatmap" }).click()
    await dialog.getByRole("combobox", { name: "Initial range" }).click()
    await page.getByRole("option", { name: "6 hours" }).click()
    await dialog.getByRole("button", { name: "Add" }).click()
    await page.getByRole("button", { name: "Save" }).click()
    await expect(page.getByRole("button", { name: "Customize" })).toBeVisible()

    const widget = page.locator("[data-cpu-usage]")
    await expect(widget).toHaveAttribute("data-view", "heatmap")
    await expect(widget).toContainText(`CPU usage · ${name}`)
    await expect(widget.getByRole("radiogroup", { name: "Range" }).getByRole("radio", { name: "6 h" })).toHaveAttribute("aria-checked", "true")
  } finally {
    await page.request.delete("/api/dashboard")
  }
})
