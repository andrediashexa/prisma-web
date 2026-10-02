import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

test("the Pools table is visible on the CGNAT screen (regression from #3)", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/cgnat`)
  const card = page.locator("[data-slot=card]", { has: page.getByText("Pools", { exact: true }) })
  const table = card.getByRole("table")
  await expect(table).toBeVisible()
  const row = table.getByRole("row").nth(1)
  await expect(row).toBeVisible()
  // toBeVisible ignores clipping: the bug in #3 left the table in the DOM, cut off by its card.
  // What is drawn at the middle of the first row must be that row.
  // Scroll the page only: scrollIntoView would also scroll a clipping card and hide the bug.
  const drawn = await row.evaluate((el) => {
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 200)
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!hit && el.contains(hit)
  })
  expect(drawn, "the first pool row is drawn, not clipped or covered").toBe(true)
})

test("the home page keeps its layout after a reload", async ({ page }) => {
  await page.request.delete("/api/dashboard")
  try {
    await page.goto("/")
    await page.getByRole("button", { name: "Customize" }).click()
    const options = page.getByRole("button", { name: "Widget options" })
    await expect(options.first()).toBeVisible()
    const before = await options.count()
    await options.first().click()
    await page.getByRole("menuitem", { name: "Remove" }).click()
    await expect(options).toHaveCount(before - 1)
    await page.getByRole("button", { name: "Save" }).click()
    await expect(page.getByRole("button", { name: "Customize" })).toBeVisible()
    await page.reload()
    await page.getByRole("button", { name: "Customize" }).click()
    await expect(options).toHaveCount(before - 1)
    await page.getByRole("button", { name: "Cancel" }).click()
  } finally {
    await page.request.delete("/api/dashboard")
  }
})
