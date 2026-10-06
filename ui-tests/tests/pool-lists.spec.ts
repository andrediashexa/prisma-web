import { expect, test, type APIRequestContext } from "@playwright/test"

import { routerId } from "./helpers"

// A CGNAT pool's sides as prefix-lists (Prisma 0.151.12, #73), on the typed mock.

const R = () => `/api/routers/${routerId()}/config`

async function commitLines(api: APIRequestContext, edits: [string[], string[]][], comment: string) {
  const c = await (await api.post(`${R()}/candidates`)).json()
  for (const [path, lines] of edits) {
    const res = await api.post(`${R()}/candidates/${c.candidate_id}/edit`, { data: { path, lines } })
    if (!res.ok()) throw new Error(`edit failed: ${res.status()} ${await res.text()}`)
  }
  const res = await api.post(`${R()}/candidates/${c.candidate_id}/commit`, { data: { comment, acknowledge_remap: true } })
  if (!res.ok()) throw new Error(`commit failed: ${res.status()} ${await res.text()}`)
}

test("a pool's inside side is given by a prefix-list from the form", async ({ page }) => {
  await commitLines(page.request, [[[], ["ip prefix-list UI-SUBS seq 5 deny 100.90.1.0/24", "ip prefix-list UI-SUBS seq 10 permit 100.90.0.0/22"]]], "ui tests: lists")
  try {
    await page.goto(`/routers/${routerId()}/cgnat`)
    await page.getByRole("button", { name: "Add a pool" }).click()
    const form = page.getByRole("dialog")
    await form.getByLabel("Name").fill("UI-LISTS")
    const inside = form.locator("[data-pool-side=inside]")
    await inside.getByRole("combobox", { name: "Inside given by" }).click()
    await page.getByRole("option", { name: "A prefix-list" }).click()
    await expect(form.getByText("at least one inside prefix, or a prefix-list")).toBeVisible()
    await inside.getByRole("combobox", { name: "Inside prefix-list" }).click()
    await page.getByRole("option", { name: "UI-SUBS" }).click()
    await expect(form.locator("[data-list-note]")).toContainText("A change to the list rebuilds the pool")
    await form.getByRole("button", { name: "Add an outside prefix" }).click()
    await form.getByLabel("Outside prefixes 1").fill("198.51.100.96/28")
    await form.getByRole("button", { name: "Add to the changes" }).click()
    await expect(form).toBeHidden()

    await page.getByRole("button", { name: "Review and apply (1)" }).click()
    const review = page.getByRole("dialog")
    await expect(review.getByRole("heading", { name: "What changes" })).toBeVisible()
    const confirmed = review.getByRole("switch", { name: "Commit confirmed" })
    if ((await confirmed.getAttribute("aria-checked")) === "true") await confirmed.click()
    await review.getByRole("button", { name: "Apply", exact: true }).click()
    await expect(review).toBeHidden()

    // The table shows the list and what it resolved to.
    const row = page.getByRole("row", { name: /UI-LISTS/ })
    await expect(row.getByText("UI-SUBS")).toBeVisible({ timeout: 15_000 })
    await expect(row.getByText("100.90.2.0/23")).toBeVisible()
    await expect(row.getByText("100.90.1.0/24")).toBeVisible()
    await expect(row.getByText("not translated")).toBeVisible()

    // Back to prefixes: the review removes the list.
    await page.getByRole("button", { name: "Edit pool UI-LISTS" }).click()
    const edit = page.getByRole("dialog")
    await edit.locator("[data-pool-side=inside]").getByRole("combobox", { name: "Inside given by" }).click()
    await page.getByRole("option", { name: "Prefixes" }).click()
    await edit.getByRole("button", { name: "Add an inside prefix" }).click()
    await edit.getByLabel("Inside prefixes 1").fill("100.90.0.0/22")
    await expect(edit.getByText(/prefix_list_inside/)).toBeVisible()
    await edit.getByRole("button", { name: "Cancel" }).click()
  } finally {
    await commitLines(page.request, [[["nat", "cgnat"], ["no pool UI-LISTS"]], [[], ["no ip prefix-list UI-SUBS"]]], "ui tests: undo lists")
  }
})
