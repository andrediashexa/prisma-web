import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

test("a setting added from a generated form reaches the review as a diff, nothing committed", async ({ page }) => {
  const before = (await (await page.request.get(`/api/routers/${routerId()}/config/revisions`)).json()).revisions.length
  await page.goto(`/routers/${routerId()}/settings`)
  await page.getByRole("button", { name: "cgnat", exact: true }).click()
  await page.getByRole("button", { name: "Add a setting" }).click()
  await page.getByPlaceholder(/Search/).fill("timeout udp")
  await page.locator("[role=dialog] button").filter({ hasText: "timeout udp" }).first().click()
  const value = page.getByRole("textbox", { name: "1-4294967295" })
  await value.fill("nope")
  await expect(page.getByRole("button", { name: "Add to the changes" })).toBeDisabled()
  await value.fill("300")
  await expect(page.getByText("timeout udp 300", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Add to the changes" }).click()

  await expect(page.getByText("Changes to review")).toBeVisible()
  await page.getByRole("button", { name: /Review and apply \(1\)/ }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText(/timeout udp 300/)).toBeVisible()
  await dialog.getByRole("button", { name: "Discard" }).click()
  const after = (await (await page.request.get(`/api/routers/${routerId()}/config/revisions`)).json()).revisions.length
  expect(after).toBe(before)
})

test("a configured line opens prefilled and its change is staged as remove-then-set", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/settings`)
  await page.getByRole("button", { name: "pool RFC6598" }).click()
  await page.getByRole("button", { name: "Edit block-size 256" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("textbox").first()).toHaveValue("256")
  await dialog.getByRole("textbox").first().fill("512")
  await dialog.getByRole("button", { name: "Add to the changes" }).click()
  await expect(page.getByText("no block-size 256 ; block-size 512")).toBeVisible()
  await page.getByRole("button", { name: "Discard all" }).click()
  await expect(page.getByText("Changes to review")).toBeHidden()
})
