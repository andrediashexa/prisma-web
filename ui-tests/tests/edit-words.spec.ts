import { expect, test } from "@playwright/test"

import { linesRouterId, routerId } from "./helpers"

// `replace pattern` and `rename` (Prisma 0.151.13, #74): the plain mock reports 0.151.13.

test("a replace is previewed, then applied, and a rename is refused in the box's words", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/config`)
  await page.getByRole("button", { name: "New change" }).click()
  await page.locator("#edit-path").fill("nat / cgnat / pool RFC6598")
  const words = page.locator("[data-edit-words]")
  await expect(words).toBeVisible()

  await words.getByLabel("Pattern").fill("prefix-inside 100\\.64\\.0\\.0/10")
  await words.getByLabel("Replacement").fill("prefix-inside 100.64.0.0/11")
  await words.getByRole("button", { name: "Preview" }).click()
  await expect(words.locator("[data-edit-preview]")).toContainText("+ prefix-inside 100.64.0.0/11")
  // The preview staged nothing.
  await expect(page.getByText("Applied to this candidate")).toHaveCount(0)

  await words.getByRole("button", { name: "Replace in the candidate" }).click()
  await expect(page.getByText("Applied to this candidate")).toBeVisible()
  await expect(page.getByText('replace pattern "prefix-inside 100\\.64\\.0\\.0/10" with "prefix-inside 100.64.0.0/11"')).toBeVisible()

  await words.getByRole("tab", { name: "Rename" }).click()
  await words.getByLabel("Current name").fill("NOPE")
  await words.getByLabel("New name").fill("OTHER")
  await words.getByRole("button", { name: "Rename in the candidate" }).click()
  await expect(words.getByRole("alert")).toContainText("no pool NOPE")

  await page.getByRole("button", { name: "Discard" }).click()
})

test("a router before 0.151.13 is not offered replace or rename", async ({ page }) => {
  await page.goto(`/routers/${linesRouterId()}/config`)
  await page.getByRole("button", { name: "New change" }).click()
  await expect(page.locator("#edit-path")).toBeVisible()
  await expect(page.locator("[data-edit-words]")).toHaveCount(0)
  await page.getByRole("button", { name: "Discard" }).click()
})
