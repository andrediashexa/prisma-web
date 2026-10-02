import { readFileSync } from "node:fs"

import type { APIRequestContext, Page } from "@playwright/test"

export const routerId = (): string => JSON.parse(readFileSync(".state/router.json", "utf8")).id

/** Opens a change on the configuration screen and applies lines at a level. */
export async function applyLines(page: Page, level: string, lines: string) {
  await page.goto(`/routers/${routerId()}/config`)
  await page.getByRole("button", { name: "New change" }).click()
  await page.locator("#edit-path").fill(level)
  await page.locator("#edit-lines").fill(lines)
  await page.getByRole("button", { name: "Apply to candidate" }).click()
}

/** Puts the simulated Prisma back on the revision before the last commit. */
export async function undoLastCommit(api: APIRequestContext) {
  const R = `/api/routers/${routerId()}/config`
  const c = await (await api.post(`${R}/candidates`, { data: { from_revision: 1 } })).json()
  const res = await api.post(`${R}/candidates/${c.candidate_id}/commit`, {
    data: { comment: "ui tests: undo", acknowledge_remap: true },
  })
  if (!res.ok()) throw new Error(`undo failed: ${res.status()} ${await res.text()}`)
}
