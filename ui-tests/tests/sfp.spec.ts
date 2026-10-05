import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

// Third-party SFP+ modules, opt-in (Prisma 0.151.2, #69).

test("the interfaces tab shows the SFP+ setting and stages allowing them for the review", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/interfaces`)
  const card = page.locator("[data-unsupported-sfp]")
  await expect(card).toContainText("refused")
  await card.getByRole("button", { name: "Allow them" }).click()
  // The staged list shows the line, and the change's warning that the next boot applies it.
  await expect(page.getByText("unsupported-sfp allow", { exact: true })).toBeVisible()
  await expect(page.getByText("It takes effect at the next boot of the router.")).toBeVisible()
})
