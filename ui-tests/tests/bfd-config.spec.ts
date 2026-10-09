import { expect, test } from "@playwright/test"

import { linesRouterId, routerId } from "./helpers"

// BFD's configuration as fields (Prisma 0.150.12, #67).

test("a BFD profile and a session naming it are staged as fields and reach the review", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/routing/bfd`)
  const card = page.locator("[data-bfd-config]")
  await card.getByRole("button", { name: "Add a profile" }).click()
  let dialog = page.getByRole("dialog")
  await dialog.getByLabel("Name").fill("ui-fast")
  await dialog.getByLabel("Receive interval (ms)").fill("5")
  await expect(dialog.getByRole("button", { name: "Add to the changes" })).toBeDisabled()
  await dialog.getByLabel("Receive interval (ms)").fill("200")
  await dialog.getByRole("button", { name: "Add to the changes" }).click()
  await card.getByRole("button", { name: "Add a session" }).click()
  dialog = page.getByRole("dialog")
  await dialog.getByLabel("Peer address").fill("192.0.2.99")
  await dialog.getByLabel("Interface").fill("lan0")
  await dialog.getByRole("button", { name: "Add to the changes" }).click()
  await page.getByRole("button", { name: /Review and apply \(2\)/ }).click()
  const review = page.getByRole("dialog")
  await expect(review.getByText("receive-interval 200").first()).toBeVisible()
  await expect(review.getByText("peer 192.0.2.99 interface lan0").first()).toBeVisible()
  await review.getByRole("button", { name: "Discard" }).click()
})

test("a router before 0.150.12 has no BFD form", async ({ page }) => {
  await page.goto(`/routers/${linesRouterId()}/routing/bfd`)
  await expect(page.getByRole("navigation", { name: "Routing" })).toBeVisible()
  await expect(page.locator("[data-bfd-config]")).toHaveCount(0)
})
