import { expect, test } from "@playwright/test"

import { applyLines, routerId, undoLastCommit } from "./helpers"

test("a VTY refusal shows the path and the line it refers to", async ({ page }) => {
  await applyLines(page, "interface lan0", "mtu 1000")
  await expect(page.getByText("The VTY rejected the change")).toBeVisible()
  await expect(page.getByText("interface lan0 › mtu 1000")).toBeVisible()
  await page.getByRole("button", { name: "Discard" }).click()
})

test("Apply stays disabled until every gate is acknowledged", async ({ page }) => {
  // A new block size remaps every subscriber of the pool: the remap gate.
  await applyLines(page, "nat / cgnat / pool RFC6598", "block-size 512")
  await expect(page.getByText("Applied to this candidate")).toBeVisible()
  await page.getByRole("button", { name: "Review and apply" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("This change requires acknowledgment")).toBeVisible()
  const apply = dialog.getByRole("button", { name: /^Apply/ })
  await expect(apply).toBeDisabled()
  await dialog.locator("label", { hasText: "public address or port block" }).getByRole("switch").click()
  await expect(apply).toBeEnabled()
  // Nothing is committed: back to the editor and discard.
  await dialog.getByRole("button", { name: "Back" }).click()
  await page.getByRole("button", { name: "Discard" }).click()
  await expect(page.getByRole("button", { name: "New change" })).toBeVisible()
})

test("the pending-commit banner counts down and goes away once confirmed", async ({ page }) => {
  const R = `/api/routers/${routerId()}/config`
  const c = await (await page.request.post(`${R}/candidates`)).json()
  await page.request.post(`${R}/candidates/${c.candidate_id}/edit`, { data: { path: ["interface lan0"], lines: ["mtu 9000"] } })
  const commit = await page.request.post(`${R}/candidates/${c.candidate_id}/commit`, {
    data: { comment: "ui tests", confirmed_minutes: 2, acknowledge_remap: true },
  })
  expect(commit.ok()).toBeTruthy()
  try {
    await page.goto(`/routers/${routerId()}`)
    const banner = page.getByText("Change awaiting confirmation")
    await expect(banner).toBeVisible()
    const clock = banner.locator("span.font-mono")
    await expect(clock).toHaveText(/^\d+:\d\d$/)
    const first = await clock.textContent()
    await expect(clock).not.toHaveText(first!, { timeout: 5_000 })
    await page.getByRole("button", { name: "Confirm change" }).click()
    await expect(banner).toBeHidden()
  } finally {
    await undoLastCommit(page.request)
  }
})
