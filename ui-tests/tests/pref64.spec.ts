import { expect, test } from "@playwright/test"

// On the line-only mock: the form's lines (#40) carry PREF64 too (Prisma 0.150.2, #61).
import { linesRouterId as routerId } from "./helpers"

test("PREF64 is offered while router advertisements go out, and staged as ipv6 nd nat64", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/interfaces`)
  await page.getByRole("button", { name: "Edit lan0" }).click()
  const dialog = page.getByRole("dialog")
  const pref = dialog.locator("[data-pref64]")
  await expect(pref).toBeVisible()
  const input = pref.getByLabel("New NAT64 prefixes (PREF64) prefix")
  await input.fill("64:ff9b::1")
  await expect(pref.getByText("an IPv6 prefix")).toBeVisible()
  await input.fill("64:ff9b::/96")
  await pref.getByRole("button", { name: "Add NAT64 prefixes (PREF64) prefix" }).click()
  await expect(pref.getByText("64:ff9b::/96", { exact: true })).toBeVisible()
  // Suppressing the advertisements with a PREF64 in the list is refused before the review.
  await dialog.getByLabel("Suppress router advertisements").click()
  await expect(pref.getByText("they must not be suppressed")).toBeVisible()
  await dialog.getByLabel("Suppress router advertisements").click()
  await expect(dialog.getByTestId("interface-lines")).toHaveText("ipv6 nd nat64 64:ff9b::/96")
  await dialog.getByRole("button", { name: "Cancel" }).click()
})
