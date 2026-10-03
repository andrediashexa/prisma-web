import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

test("a setting can be checked by the router before it is staged", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/settings`)
  await expect(page.getByText(/Grammar from the router/)).toBeVisible()
  await page.getByRole("button", { name: "interface lan0", exact: true }).click()
  await page.getByRole("button", { name: "Add a setting" }).click()
  await page.getByPlaceholder(/Search/).fill("mtu")
  await page.locator("[role=dialog] button").filter({ hasText: /^mtu/ }).first().click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("textbox").first().fill("1400")
  await dialog.getByRole("button", { name: "Check with the router" }).click()
  await expect(dialog.getByText("The router accepts this line.")).toBeVisible()
  // Nothing staged by the check.
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(page.getByText("Changes to review")).toBeHidden()
})

test("the box's own lines are read only, with the box's reason", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/settings`)
  await page.getByRole("button", { name: "top level" }).click()
  const line = page.locator("div", { hasText: /^log syslog informational/ }).first()
  await expect(line.getByText("the box's own")).toBeVisible()
  await expect(page.getByRole("button", { name: "Edit log syslog informational" })).toHaveCount(0)
})
