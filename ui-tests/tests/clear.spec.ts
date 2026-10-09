import { expect, test } from "@playwright/test"

import { linesRouterId, routerId } from "./helpers"

// The VTY's clear lines (Prisma 0.149.25, #48): offered where the object is shown,
// each after a confirmation that says what it disrupts.

test("a BGP session is cleared softly after a confirmation, and the box says the command", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/routing/bgp`)
  const button = page.getByRole("button", { name: /^Clear the BGP session with / }).first()
  await expect(button).toBeVisible()
  const peer = ((await button.getAttribute("aria-label")) ?? "").replace("Clear the BGP session with ", "")
  await button.click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText(/a hard clear drops the session/)).toBeVisible()
  await dialog.getByRole("button", { name: "Clear", exact: true }).click()
  await expect(page.getByText(`Done: clear ip bgp ${peer} soft`, { exact: true })).toBeVisible()
  await expect(dialog).toBeHidden()
})

test("a subscriber's sessions and the interface counters are cleared after their warnings", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/cgnat`)
  await page.getByPlaceholder("100.64.1.23").fill("100.64.0.10")
  await page.getByRole("button", { name: "Search" }).click()
  await page.getByRole("button", { name: "Clear sessions the sessions of 100.64.0.10" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText(/Its port blocks stay with it/)).toBeVisible()
  await dialog.getByRole("button", { name: "Clear", exact: true }).click()
  await expect(page.getByText("Done: clear cgnat subscriber 100.64.0.10", { exact: true })).toBeVisible()

  // Interface counters: every interface, with the charts' warning.
  await page.goto(`/routers/${routerId()}/interfaces`)
  await page.getByRole("button", { name: "Clear counters every interface's counters" }).click()
  await expect(page.getByRole("dialog").getByText(/the ones the charts and the history read/)).toBeVisible()
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click()
})

test("a router before 0.149.25 is offered no clear", async ({ page }) => {
  await page.goto(`/routers/${linesRouterId()}/routing/ospf`)
  await expect(page.getByText("OSPF / OSPFv3 neighbors")).toBeVisible()
  await expect(page.getByRole("button", { name: /Restart OSPF/ })).toHaveCount(0)
  await page.goto(`/routers/${linesRouterId()}/routing/bgp`)
  await expect(page.getByText("BGP", { exact: true }).first()).toBeVisible()
  await expect(page.getByRole("button", { name: /^Clear the BGP session/ })).toHaveCount(0)
  await page.goto(`/routers/${linesRouterId()}/interfaces`)
  await expect(page.getByRole("button", { name: /Clear counters/ })).toHaveCount(0)
})
