import { expect, test } from "@playwright/test"

import { linesRouterId, routerId } from "./helpers"

// `show log` and why each start (Prisma 0.151.14, #75): the plain mock reports 0.151.14.

const hook = (page: import("@playwright/test").Page, command: string) => page.request.post(`/api/routers/${routerId()}/show`, { data: { command } })

test("the box's log is shown with its filters, and a refused filter in the box's words", async ({ page }) => {
  await page.goto(`/routers/${routerId()}`)
  const card = page.locator("[data-box-log]")
  await expect(card.locator("[data-event-kind=boot]")).toBeVisible()
  await card.getByRole("combobox", { name: "Source" }).click()
  await page.getByRole("option", { name: "Host" }).click()
  await expect(card.locator("[data-event-kind=commit]")).toHaveCount(0)
  await expect(card.locator("[data-event-kind=boot]")).toBeVisible()
  await card.getByLabel("Since").fill("yesterday")
  await expect(card.getByRole("alert")).toContainText("is not a time")
})

test("the Uptime card says why the dataplane restarted, and 'by itself' only when nothing asked", async ({ page }) => {
  try {
    await page.goto(`/routers/${routerId()}`)
    const note = page.locator("[data-restart-note]")
    await hook(page, "mock dataplane-start unexpected")
    await page.reload()
    await expect(note).toHaveAttribute("data-restart-note", "destructive")
    await expect(note).toContainText("restarted by itself")
    await hook(page, "mock dataplane-start operator")
    await page.reload()
    await expect(note).toHaveAttribute("data-restart-note", "info")
    await expect(note).toContainText("on request")
    await expect(note).not.toContainText("by itself")
    await hook(page, "mock dataplane-start none")
    await page.reload()
    await expect(note).toHaveAttribute("data-restart-note", "warning")
    await expect(note).toContainText("has not recorded why")
  } finally {
    await hook(page, "mock dataplane-start boot")
  }
})

test("a router before 0.151.14 shows no box log", async ({ page }) => {
  await page.goto(`/routers/${linesRouterId()}`)
  await expect(page.getByText("Uptime", { exact: true })).toBeVisible()
  await expect(page.locator("[data-box-log]")).toHaveCount(0)
})
