import { expect, type Page, test } from "@playwright/test"

import { applyLines, routerId, undoLastCommit } from "./helpers"

/** Another change lands on the box while ours is open (someone at the prompt, another operator). */
async function commitElsewhere(page: Page, path: string[], lines: string[]) {
  const R = `/api/routers/${routerId()}/config`
  const c = await (await page.request.post(`${R}/candidates`)).json()
  await page.request.post(`${R}/candidates/${c.candidate_id}/edit`, { data: { path, lines } })
  const res = await page.request.post(`${R}/candidates/${c.candidate_id}/commit`, { data: { comment: "ui tests: elsewhere" } })
  expect(res.ok()).toBeTruthy()
}

async function applyAndHitStale(page: Page) {
  await page.getByRole("button", { name: "Review and apply" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("passed")).toBeVisible()
  await dialog.getByRole("button", { name: /^Apply/ }).click()
  await expect(dialog.getByText(/running configuration changed since this change was opened/)).toBeVisible()
  await dialog.getByRole("button", { name: "Reopen and apply again" }).click()
}

test("a moved base reopens, applies the lines again and shows the new diff without committing", async ({ page }) => {
  await applyLines(page, "interface lan0", "description ui mine")
  const before = await page.locator("[data-slot=card-action]").last().textContent()
  await commitElsewhere(page, ["interface wg0"], ["description ui theirs"])
  try {
    await applyAndHitStale(page)
    // A new candidate, with the same edit applied again and no commit made.
    await expect(page.locator("[data-slot=card-action]").last()).not.toHaveText(before!)
    await expect(page.getByText("Applied to this candidate")).toBeVisible()
    await expect(page.getByText("description ui mine").first()).toBeVisible()
    await page.getByRole("button", { name: "Review and apply" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("+ description ui mine").or(dialog.getByText(/description ui mine/)).first()).toBeVisible()
    await expect(dialog.getByText(/ui theirs/)).toHaveCount(0)
    await dialog.getByRole("button", { name: "Back" }).click()
    await page.getByRole("button", { name: "Discard" }).click()
  } finally {
    await undoLastCommit(page.request)
  }
})

test("a line the new base refuses is shown like any edit refusal", async ({ page }) => {
  await applyLines(page, "interface lan0", "description ui mine\nno ipv4 address 192.168.10.1/24")
  await expect(page.getByText("Applied to this candidate")).toBeVisible()
  // The same address goes away elsewhere first: removing it again is refused,
  // while the description keeps the change worth applying.
  await commitElsewhere(page, ["interface lan0"], ["no ipv4 address 192.168.10.1/24"])
  try {
    await applyAndHitStale(page)
    await expect(page.getByText("The VTY rejected the change")).toBeVisible()
    await expect(page.getByText("interface lan0 › no ipv4 address 192.168.10.1/24")).toBeVisible()
    // Its lines are back in the form, to fix or drop.
    await expect(page.locator("#edit-lines")).toHaveValue("description ui mine\nno ipv4 address 192.168.10.1/24")
    await page.getByRole("button", { name: "Discard" }).click()
  } finally {
    await undoLastCommit(page.request)
  }
})
