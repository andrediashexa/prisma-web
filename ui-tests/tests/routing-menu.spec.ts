import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

// The Routing menu (#88): one page per protocol and the routing table, one set of staged changes.

const PAGES = [
  { label: "Routing table", path: "", shows: "Route summary" },
  { label: "Static", path: "/static", shows: "Add route" },
  { label: "BGP", path: "/bgp", shows: "Add neighbor" },
  { label: "OSPF", path: "/ospf", shows: "OSPF / OSPFv3 neighbors" },
  { label: "IS-IS", path: "/isis", shows: "IS-IS" },
  { label: "BFD", path: "/bfd", shows: "Add a profile" },
  { label: "VRRP", path: "/vrrp", shows: "VRRP" },
  { label: "Logging", path: "/logging", shows: "bgpd" },
]

test("the sidebar's Routing opens a sub-menu, a page per protocol and the routing table", async ({ page }) => {
  const base = `/routers/${routerId()}`
  await page.goto(base)
  const sidebar = page.locator("[data-sidebar=sidebar]")
  await expect(sidebar.getByRole("list", { name: "Routing" })).toHaveCount(0)
  await sidebar.getByRole("link", { name: "Routing", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${base}/routing$`))
  const menu = sidebar.getByRole("list", { name: "Routing" })
  await expect(menu.getByRole("link")).toHaveText(PAGES.map((p) => p.label))

  for (const p of PAGES) {
    await menu.getByRole("link", { name: p.label, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${base}/routing${p.path}$`))
    await expect(menu.getByRole("link", { name: p.label, exact: true })).toHaveAttribute("data-active", "true")
    await expect(page.getByRole("navigation", { name: "Routing" }).getByRole("link", { name: p.label, exact: true })).toHaveAttribute("aria-current", "page")
    await expect(page.getByRole("main").getByText(p.shows, { exact: true }).first()).toBeVisible()
  }

  // Leaving Routing closes the sub-menu.
  await sidebar.getByRole("link", { name: "Interfaces", exact: true }).click()
  await expect(sidebar.getByRole("list", { name: "Routing" })).toHaveCount(0)
})

test("a change staged on one routing page stays staged on another, for one review", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/routing/static`)
  await page.getByRole("button", { name: "Add route" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Prefix", { exact: true }).fill("198.51.100.88/32")
  await dialog.getByLabel("Next hop", { exact: true }).fill("203.0.113.9")
  await dialog.getByRole("button", { name: "Add to the changes" }).click()
  await expect(page.locator("[data-staged]")).toHaveCount(1)

  await page.getByRole("navigation", { name: "Routing" }).getByRole("link", { name: "BGP", exact: true }).click()
  await expect(page.getByRole("button", { name: "Add neighbor" })).toBeVisible()
  await expect(page.locator("[data-staged]")).toHaveCount(1)
  await expect(page.locator("[data-staged]")).toContainText("198.51.100.88/32")
  await expect(page.getByRole("button", { name: /Review and apply \(1\)/ })).toBeVisible()
})

test("the bundles are on the Interfaces page", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/interfaces`)
  await expect(page.getByText("Bundles", { exact: true })).toBeVisible()
  await expect(page.getByRole("main").getByText("BondEthernet0").first()).toBeVisible()
})
