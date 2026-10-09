import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

// The sidebar's sub-menus open and close from their chevrons (#90).

test("Routing's and Policies' sub-menus collapse and expand without leaving the page", async ({ page }) => {
  const base = `/routers/${routerId()}`
  await page.goto(`${base}/routing/bgp`)
  const sidebar = page.locator("[data-sidebar=sidebar]")
  const routing = sidebar.getByRole("button", { name: "Routing pages" })
  await expect(routing).toHaveAttribute("aria-expanded", "true")
  await expect(sidebar.getByRole("list", { name: "Routing" })).toBeVisible()

  await routing.click()
  await expect(routing).toHaveAttribute("aria-expanded", "false")
  await expect(sidebar.getByRole("list", { name: "Routing" })).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`${base}/routing/bgp$`))
  await routing.click()
  await expect(sidebar.getByRole("list", { name: "Routing" })).toBeVisible()

  // Policies opens from its chevron while on a Routing page, and closes again.
  const policies = sidebar.getByRole("button", { name: "Policies pages" })
  await expect(policies).toHaveAttribute("aria-expanded", "false")
  await policies.click()
  await expect(sidebar.getByRole("list", { name: "Policies" }).getByRole("link")).toHaveText(["Policy", "Prefix-list", "BGP community"])
  await policies.click()
  await expect(sidebar.getByRole("list", { name: "Policies" })).toHaveCount(0)

  // Following the link opens it again after it was closed.
  await routing.click()
  await sidebar.getByRole("link", { name: "Routing", exact: true }).click()
  await expect(sidebar.getByRole("list", { name: "Routing" })).toBeVisible()
})

test("a router's pages collapse and expand from its chevron", async ({ page }) => {
  const name = (await (await page.request.get("/api/routers")).json()).find((r: { id: string }) => r.id === routerId()).name
  await page.goto(`/routers/${routerId()}/interfaces`)
  const sidebar = page.locator("[data-sidebar=sidebar]")
  const toggle = sidebar.getByRole("button", { name: `${name} pages` })
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(sidebar.getByRole("link", { name: "Interfaces", exact: true })).toBeVisible()
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(sidebar.getByRole("link", { name: "Interfaces", exact: true })).toHaveCount(0)
  await toggle.click()
  await expect(sidebar.getByRole("link", { name: "Interfaces", exact: true })).toBeVisible()
})
