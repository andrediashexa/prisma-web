import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

// Views of the core split (#85): the mock's layout is control 0-1, main 2, workers 3-7.

test("the Resources card switches between bars, a CPU map, donuts and a table, and remembers the view", async ({ page }) => {
  await page.goto(`/routers/${routerId()}`)
  const card = page.locator("[data-resources]")
  const view = card.getByRole("radiogroup", { name: "View" })
  await expect(card).toHaveAttribute("data-view", "bars")
  await expect(card.locator("[data-plane=workers]")).toContainText("5 CPUs")

  await view.getByRole("radio", { name: "Map" }).click()
  await expect(card.locator("[data-cpu]")).toHaveCount(8)
  await expect(card.locator("[data-cpu-plane=control]")).toHaveCount(2)
  await expect(card.locator("[data-cpu-plane=main]")).toHaveCount(1)
  await expect(card.locator("[data-cpu-plane=workers]")).toHaveCount(5)
  await expect(card.locator("[data-cpu='3']")).toContainText("%")

  await view.getByRole("radio", { name: "Donut" }).click()
  await expect(card.getByRole("figure", { name: "CPUs by plane" })).toBeVisible()
  await expect(card.getByRole("figure", { name: "RAM by plane" })).toBeVisible()

  await view.getByRole("radio", { name: "Table" }).click()
  await expect(card.locator("tr[data-plane=workers]")).toContainText("3-7")

  // Remembered in this browser.
  await page.reload()
  await expect(card).toHaveAttribute("data-view", "table")
})

test("the home dashboard takes a CPUs and RAM widget, its view chosen when added and switched in place", async ({ page }) => {
  const name = (await (await page.request.get("/api/routers")).json()).find((r: { id: string }) => r.id === routerId()).name
  await page.request.delete("/api/dashboard")
  try {
    await page.goto("/")
    await page.getByRole("button", { name: "Customize" }).click()
    await page.getByRole("button", { name: "Add widget" }).first().click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("button", { name: /CPUs and RAM by plane/ }).click()
    await dialog.getByRole("combobox").first().click()
    await page.getByRole("option", { name, exact: true }).click()
    await dialog.getByRole("combobox", { name: "View" }).click()
    await page.getByRole("option", { name: "Map" }).click()
    await dialog.getByRole("button", { name: "Add" }).click()
    await page.getByRole("button", { name: "Save" }).click()
    await expect(page.getByRole("button", { name: "Customize" })).toBeVisible()

    const widget = page.locator("[data-resources]")
    await expect(widget).toHaveAttribute("data-view", "map")
    await expect(widget).toContainText(`CPUs and RAM · ${name}`)
    await expect(widget.locator("[data-cpu]")).toHaveCount(8)
    await widget.getByRole("radiogroup", { name: "View" }).getByRole("radio", { name: "Table" }).click()
    await expect(widget).toHaveAttribute("data-view", "table")
  } finally {
    await page.request.delete("/api/dashboard")
  }
})
