import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

// NAT64 in its own hierarchy and mode bpa (Prisma 0.151.0, #68), on the typed mock.

test("a NAT64 pool is staged under nat > nat64, and a CGNAT pool cannot turn into one", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/cgnat`)
  await page.getByRole("button", { name: "Add a pool" }).click()
  const form = page.getByRole("dialog")
  await form.getByLabel("Name").fill("UI68")
  await form.getByRole("button", { name: "Add an inside prefix" }).click()
  await form.getByLabel("Inside prefixes 1").fill("2001:db8:1600::/40")
  await form.getByRole("button", { name: "Add an outside prefix" }).click()
  await form.getByLabel("Outside prefixes 1").fill("198.51.100.112/28")
  await form.getByLabel("Subscriber prefix length").fill("56")
  await form.getByRole("combobox", { name: "Mode" }).click()
  await expect(page.getByRole("option", { name: "BPA (dynamic)" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(form.getByTestId("lines-preview")).toContainText("subscriber_length 56")
  await form.getByRole("button", { name: "Add to the changes" }).click()
  await page.getByRole("button", { name: /Review and apply \(1\)/ }).click()
  const review = page.getByRole("dialog")
  await expect(review.getByText("nat > nat64 > pool UI68").first()).toBeVisible()
  await review.getByRole("button", { name: "Discard" }).click()

  // An existing CGNAT pool keeps IPv4 inside prefixes: a NAT64 pool is a new one.
  await page.getByRole("button", { name: "Edit pool RFC6598" }).click()
  const edit = page.getByRole("dialog")
  await edit.getByLabel("Inside prefixes 1").fill("2001:db8:1700::/40")
  await expect(edit.getByText("add a NAT64 pool instead")).toBeVisible()
  await expect(edit.getByRole("button", { name: "Add to the changes" })).toBeDisabled()
  await edit.getByRole("button", { name: "Cancel" }).click()
})
