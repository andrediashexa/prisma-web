import { expect, test, type Page } from "@playwright/test"

import { linesRouterId, routerId } from "./helpers"

// The Policies menu (#89). The mock's policy-options: prefix-lists BOGONS (TRANSIT-IN uses it) and
// OWN-PREFIXES (CUSTOMER-OUT), communities CUSTOMERS (TRANSIT-IN) and NO-EXPORT-CUST (none),
// large BIG-CUST, extended RT-CUST; FRR's FRR-DEFAULT, FRR-DEFAULT6 and FRR-BLACKHOLE.

async function apply(page: Page) {
  await page.getByRole("button", { name: /Review and apply/ }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("passed")).toBeVisible()
  const confirmed = dialog.getByRole("switch", { name: "Commit confirmed" })
  await expect(async () => {
    if ((await confirmed.getAttribute("aria-checked")) === "true") await confirmed.click()
    await expect(confirmed).toHaveAttribute("aria-checked", "false", { timeout: 1_000 })
    await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeVisible({ timeout: 1_000 })
  }).toPass()
  await dialog.getByRole("button", { name: "Apply", exact: true }).click()
  await expect(dialog).toBeHidden()
}

test("the sidebar's Policies opens Policy, Prefix-list and BGP community", async ({ page }) => {
  const base = `/routers/${routerId()}`
  await page.goto(base)
  const sidebar = page.locator("[data-sidebar=sidebar]")
  await sidebar.getByRole("link", { name: "Policies", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${base}/policies$`))
  const menu = sidebar.getByRole("list", { name: "Policies" })
  await expect(menu.getByRole("link")).toHaveText(["Policy", "Prefix-list", "BGP community"])
  // Policy keeps what the page had.
  await expect(page.getByText("TRANSIT-IN").first()).toBeVisible()
  await expect(page.getByText("Counters", { exact: true })).toBeVisible()

  await menu.getByRole("link", { name: "Prefix-list" }).click()
  await expect(page).toHaveURL(new RegExp(`${base}/policies/prefix-lists$`))
  await expect(menu.getByRole("link", { name: "Prefix-list" })).toHaveAttribute("data-active", "true")
  await menu.getByRole("link", { name: "BGP community" }).click()
  await expect(page).toHaveURL(new RegExp(`${base}/policies/communities$`))
  await expect(page.getByRole("navigation", { name: "Policies" }).getByRole("link", { name: "BGP community" })).toHaveAttribute("aria-current", "page")
})

test("the prefix-lists show their networks and users; one is created, changed and removed through the review", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/policies/prefix-lists`)
  const card = page.locator("[data-lists=prefix-list]")
  const bogons = card.locator("tr[data-list=BOGONS]")
  await expect(bogons.locator("[data-member]")).toHaveCount(4)
  await expect(bogons.locator("[data-used-by]")).toContainText("TRANSIT-IN")
  await expect(card.locator("tr[data-list=OWN-PREFIXES]")).toContainText("2001:db8:100::/48")
  const frr = page.locator("[data-frr-prefix-lists]")
  await expect(frr.locator("tr[data-frr-list=FRR-DEFAULT]")).toContainText("0.0.0.0/0")
  await expect(frr.locator("tr[data-frr-list=FRR-DEFAULT6]")).toContainText("IPv6")

  // Removing a list a policy uses says so first.
  await card.getByRole("button", { name: "Remove prefix-list BOGONS" }).click()
  await expect(page.getByRole("dialog")).toContainText("TRANSIT-IN names it")
  await page.getByRole("button", { name: "Keep it" }).click()

  await card.getByRole("button", { name: "New prefix-list" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Name").fill("UI-LIST")
  await dialog.getByLabel("Members").fill("192.0.2.0/24 nope")
  await expect(dialog.getByText("nope: an IPv4 or IPv6 network")).toBeVisible()
  await dialog.getByLabel("Members").fill("192.0.2.0/24\n2001:db8:77::/48")
  await dialog.getByRole("button", { name: "Add to the changes" }).click()
  const row = card.locator("tr[data-list=UI-LIST]")
  await expect(row).toContainText("staged")
  await row.getByLabel("New member of UI-LIST").fill("10.0.0.0/33")
  await expect(row.getByText("an IPv4 or IPv6 network")).toBeVisible()
  await row.getByLabel("New member of UI-LIST").fill("198.18.0.0/15")
  await row.getByRole("button", { name: "Add to UI-LIST" }).click()
  await expect(row.locator("[data-member]")).toHaveCount(3)
  await expect(page.locator("[data-staged]")).toHaveCount(1)
  await expect(page.locator("[data-staged]")).toContainText("198.18.0.0/15")
  await apply(page)
  await expect(row).not.toContainText("staged")
  await expect(row.locator("[data-member]")).toHaveCount(3)
  await expect(row.locator("[data-used-by]")).toHaveCount(0)

  await row.getByRole("button", { name: "Remove 2001:db8:77::/48 from UI-LIST" }).click()
  await expect(row.locator("[data-member]")).toHaveCount(2)
  await card.getByRole("button", { name: "Remove prefix-list UI-LIST" }).click()
  await expect(row).toContainText("to be removed")
  await apply(page)
  await expect(row).toHaveCount(0)
})

test("the communities show their members and users; a change on Prefix-list stays staged here", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/policies/prefix-lists`)
  const own = page.locator("[data-lists=prefix-list] tr[data-list=OWN-PREFIXES]")
  await own.getByLabel("New member of OWN-PREFIXES").fill("203.0.113.0/24")
  await own.getByRole("button", { name: "Add to OWN-PREFIXES" }).click()
  await expect(page.locator("[data-staged]")).toHaveCount(1)

  await page.getByRole("navigation", { name: "Policies" }).getByRole("link", { name: "BGP community" }).click()
  const std = page.locator("[data-lists=community]")
  await expect(std.locator("tr[data-list=CUSTOMERS] [data-used-by]")).toContainText("TRANSIT-IN")
  await expect(std.locator("tr[data-list=NO-EXPORT-CUST]")).toContainText("no policy")
  await expect(page.locator("[data-lists=large-community] tr[data-list=BIG-CUST]")).toContainText("65000:1:100")
  await expect(page.locator("[data-lists=extended-community] tr[data-list=RT-CUST]")).toContainText("rt:65000:100")
  await expect(page.locator("[data-frr-community-lists] tr[data-frr-list=FRR-BLACKHOLE]")).toContainText("65535:666")

  const cust = std.locator("tr[data-list=NO-EXPORT-CUST]")
  await cust.getByLabel("New member of NO-EXPORT-CUST").fill("65536:1")
  await expect(cust.getByText("asn:value, each 0 to 65535")).toBeVisible()
  await cust.getByLabel("New member of NO-EXPORT-CUST").fill("65000:667")
  await cust.getByRole("button", { name: "Add to NO-EXPORT-CUST" }).click()
  await expect(page.locator("[data-staged]")).toHaveCount(2)
  await page.getByRole("button", { name: /Review and apply \(2\)/ }).click()
  const review = page.getByRole("dialog")
  await expect(review.getByText("community NO-EXPORT-CUST members 65000:666 65000:667").first()).toBeVisible()
  await expect(review.getByText("203.0.113.0/24").first()).toBeVisible()
  await review.getByRole("button", { name: "Discard" }).click()
})

test("a router before 0.149.24 says it does not report its lists", async ({ page }) => {
  await page.goto(`/routers/${linesRouterId()}/policies/prefix-lists`)
  await expect(page.locator("[data-lists-not-reported]")).toBeVisible()
  await expect(page.getByRole("button", { name: "New prefix-list" })).toHaveCount(0)
})
