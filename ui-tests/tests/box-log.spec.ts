import { expect, test } from "@playwright/test"

import { linesRouterId, routerId } from "./helpers"

// `show log` and why each start (Prisma 0.151.14, #75): the plain mock reports 0.151.14.

const hook = (page: import("@playwright/test").Page, command: string) => page.request.post(`/api/routers/${routerId()}/show`, { data: { command } })

test("the box's log is shown with its filters, and a refused filter in the box's words", async ({ page }) => {
  await page.goto(`/routers/${routerId()}`)
  const card = page.locator("[data-box-log]")
  // The newest first: the API's own commits are there.
  await expect(card.locator("[data-event-kind=commit]").first()).toBeVisible()
  await card.getByRole("combobox", { name: "Source" }).click()
  await page.getByRole("option", { name: "Host" }).click()
  await expect(card.locator("[data-event-kind=commit]")).toHaveCount(0)
  await expect(card.locator("[data-event-kind=boot]")).toBeVisible()
  await card.getByLabel("Since").fill("yesterday")
  await expect(card.getByRole("alert")).toContainText("is not a time")
})

test("the box log filters by kind and says what an event is about and why (#78)", async ({ page }) => {
  await hook(page, "mock bfd down 192.168.10.2")
  await hook(page, "mock bfd up 192.168.10.2")
  await page.goto(`/routers/${routerId()}`)
  const card = page.locator("[data-box-log]")
  await card.getByRole("combobox", { name: "Kind" }).click()
  await page.getByRole("option", { name: "BFD" }).click()
  await expect(card.locator("[data-event-kind=commit]")).toHaveCount(0)
  const bfd = card.locator("[data-event-kind=bfd]")
  await expect(bfd.first().locator("[data-subject]")).toHaveText("192.168.10.2")
  await expect(bfd.getByText("control detection time expired").first()).toBeVisible()
})

test("the box log follows events as they are written, marks what stood at start, and says where it is sent (#79)", async ({ page }) => {
  const R = `/api/routers/${routerId()}/config`
  const commit = async (lines: string[], comment: string) => {
    const c = await (await page.request.post(`${R}/candidates`)).json()
    await page.request.post(`${R}/candidates/${c.candidate_id}/edit`, { data: { path: ["system", "logging"], lines } })
    const res = await page.request.post(`${R}/candidates/${c.candidate_id}/commit`, { data: { comment } })
    if (!res.ok()) throw new Error(`commit failed: ${res.status()} ${await res.text()}`)
  }
  await commit(["host 192.0.2.62 protocol tcp"], "ui tests: remote syslog")
  try {
    await page.goto(`/routers/${routerId()}`)
    const card = page.locator("[data-box-log]")
    await card.getByRole("combobox", { name: "Kind" }).click()
    await page.getByRole("option", { name: "Transceivers" }).click()
    await expect(card.locator("[data-standing]").first()).toBeVisible()
    await expect(card.locator("[data-destination='192.0.2.62']")).toContainText("not reached")
    await expect(card.locator("[data-destination='192.0.2.62']")).toContainText("connection refused")

    await card.getByRole("combobox", { name: "Kind" }).click()
    await page.getByRole("option", { name: "BFD" }).click()
    const before = await card.locator("[data-event-kind=bfd]").count()
    await card.getByRole("switch", { name: "Follow" }).click()
    await expect(card.getByText("live", { exact: true })).toBeVisible()
    await hook(page, "mock bfd down 192.168.10.3")
    await expect(card.locator("[data-event-kind=bfd]")).toHaveCount(before + 1, { timeout: 10_000 })
    await expect(card.locator("[data-event-kind=bfd]").first().locator("[data-subject]")).toHaveText("192.168.10.3")
  } finally {
    await hook(page, "mock bfd up 192.168.10.3")
    await commit(["no host 192.0.2.62"], "ui tests: undo remote syslog")
  }
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
  await expect(page.locator("[data-slot=card-title]", { hasText: /^Uptime$/ })).toBeVisible()
  await expect(page.locator("[data-box-log]")).toHaveCount(0)
})
