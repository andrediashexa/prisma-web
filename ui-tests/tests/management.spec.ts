import { expect, test, type APIRequestContext } from "@playwright/test"

import { linesRouterId, routerId } from "./helpers"

// Management in a VRF of its own (Prisma 0.152.4, #82): the plain mock reports 0.152.4.

async function commit(api: APIRequestContext, edits: [string[], string[]][], comment: string) {
  const R = `/api/routers/${routerId()}/config`
  const c = await (await api.post(`${R}/candidates`)).json()
  for (const [path, lines] of edits) await api.post(`${R}/candidates/${c.candidate_id}/edit`, { data: { path, lines } })
  const res = await api.post(`${R}/candidates/${c.candidate_id}/commit`, { data: { comment } })
  if (!res.ok()) throw new Error(`commit failed: ${res.status()} ${await res.text()}`)
}

test("the Interfaces tab says where management lives: the main table, then a VRF of its own", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/interfaces`)
  const card = page.locator("[data-management]")
  await expect(card.locator("[data-management-where]")).toHaveText("main table")
  await expect(card).toContainText("shares the main table")
  await expect(card.getByRole("link", { name: /system > management/ })).toBeVisible()
  await commit(page.request, [[["vrf UI-MGMT table 101"], ["description ui"]], [["system", "management"], ["vrf UI-MGMT"]]], "ui tests: management vrf")
  try {
    await page.reload()
    await expect(card.locator("[data-management-where]")).toHaveText("VRF UI-MGMT")
    await expect(card).toContainText("UI-MGMT · table 101")
    await expect(card).toContainText("eno1")
    await expect(card.locator("[data-management-host]")).toContainText("Main-table listeners answer on the VRF")
  } finally {
    await commit(page.request, [[["system", "management"], ["no vrf"]], [[], ["no vrf UI-MGMT table 101"]]], "ui tests: undo management vrf")
  }
})

test("a router before 0.152.4 shows no management card", async ({ page }) => {
  await page.goto(`/routers/${linesRouterId()}/interfaces`)
  await expect(page.getByRole("button", { name: "Edit lan0", exact: true })).toBeVisible()
  await expect(page.locator("[data-management]")).toHaveCount(0)
})
