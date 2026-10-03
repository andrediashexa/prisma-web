import { expect, test, type Page } from "@playwright/test"

import { routerId } from "./helpers"

const revisions = async (page: Page) =>
  (await (await page.request.get(`/api/routers/${routerId()}/config/revisions`)).json()).revisions.length

test("the interface form refuses bad addresses and stages a dual-stack change that reaches the review", async ({ page }) => {
  const before = await revisions(page)
  await page.goto(`/routers/${routerId()}/interfaces`)
  await page.getByRole("button", { name: "Edit wan0" }).click()
  const form = page.getByRole("dialog")
  await expect(form.getByLabel("Description")).toHaveValue("Carrier uplink")

  // Invalid addresses never reach the box: refused as typed, and nothing can be saved meanwhile.
  const v6 = form.getByRole("textbox", { name: "New IPv6 address" })
  await v6.fill("2001:db8::zz/64")
  await expect(form.getByText("not an IPv6 address with a prefix length")).toBeVisible()
  await expect(form.getByRole("button", { name: "Add IPv6 address" })).toBeDisabled()
  await expect(form.getByRole("button", { name: "Add to the changes" })).toBeDisabled()
  const v4 = form.getByRole("textbox", { name: "New IPv4 address" })
  await v4.fill("192.168.10.5/24")
  await expect(form.getByText("overlaps 192.168.10.1/24 on lan0")).toBeVisible()
  await v4.fill("203.0.113.8/29")
  await expect(form.getByText("network address")).toBeVisible()
  await v4.fill("")

  await v6.fill("2001:db8:100::3/64")
  await form.getByRole("button", { name: "Add IPv6 address" }).click()
  await form.getByRole("button", { name: "Remove 203.0.113.10/29" }).click()
  await form.getByLabel("VRF").fill("10")
  const lines = form.getByTestId("interface-lines")
  await expect(lines).toHaveText(["no ipv4 address 203.0.113.10/29\nipv6 address 2001:db8:100::3/64\nvrf 10"])
  await form.getByRole("button", { name: "Add to the changes" }).click()

  await expect(page.getByText("Changes to review")).toBeVisible()
  await expect(page.getByText("staged", { exact: true })).toBeVisible()
  // Editing again continues from what is staged.
  await page.getByRole("button", { name: "Edit wan0" }).click()
  await expect(form.getByText("2001:db8:100::3/64", { exact: true })).toBeVisible()
  await expect(form.getByRole("button", { name: "Remove 203.0.113.10/29" })).toBeHidden()
  await form.getByRole("button", { name: "Cancel" }).click()

  await page.getByRole("button", { name: /Review and apply \(1\)/ }).click()
  const review = page.getByRole("dialog")
  await expect(review.getByText(/\+\s+ipv6 address 2001:db8:100::3\/64/)).toBeVisible()
  await expect(review.getByText(/-\s+ipv4 address 203\.0\.113\.10\/29/)).toBeVisible()
  await expect(review.getByText(/\+\s+vrf 10/)).toBeVisible()
  await review.getByRole("button", { name: "Discard" }).click()
  expect(await revisions(page)).toBe(before)
})

test("a new bundle takes its members and reaches the review as interface bond<n>", async ({ page }) => {
  const before = await revisions(page)
  await page.goto(`/routers/${routerId()}/interfaces`)
  await page.getByRole("button", { name: "New bundle" }).click()
  await page.getByLabel("Bundle number").fill("3")
  await page.getByRole("button", { name: "Continue" }).click()

  const form = page.getByRole("dialog")
  await expect(form.getByText("New bundle")).toBeVisible()
  await form.getByLabel("Description").fill("ui bundle")
  await form.getByRole("switch", { name: "Member wg0" }).click()
  await form.getByRole("combobox", { name: "LACP mode" }).click()
  await page.getByRole("option", { name: "active" }).click()
  await expect(form.getByTestId("interface-lines")).toHaveText(["description ui bundle\nmember wg0\nlacp mode active"])
  await form.getByRole("button", { name: "Add to the changes" }).click()
  // It has no row before the commit; it stays reachable to edit again.
  await expect(page.getByRole("button", { name: "Edit bond3" })).toBeVisible()

  await page.getByRole("button", { name: /Review and apply \(1\)/ }).click()
  const review = page.getByRole("dialog")
  await expect(review.getByText(/\+ interface bond3/)).toBeVisible()
  await expect(review.getByText(/\+\s+member wg0/)).toBeVisible()
  await review.getByRole("button", { name: "Discard" }).click()
  expect(await revisions(page)).toBe(before)
})
