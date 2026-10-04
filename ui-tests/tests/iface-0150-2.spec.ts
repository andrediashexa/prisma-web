import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

// Prisma 0.150.2's SetConfig fails on every interface (#62): the form writes lines there.
// The typed mock is made to read as 0.150.2 by rewriting the fleet status it reports; on its
// own release the same form sends fields (typed-forms.spec.ts).
test("on Prisma 0.150.2 the interface form stages lines, not fields", async ({ page }) => {
  await page.route("**/api/routers/status", async (route) => {
    const res = await route.fetch()
    const fleet = (await res.json()) as { id: string; version: { release: string } | null }[]
    for (const r of fleet) if (r.id === routerId() && r.version) r.version.release = "0.150.2"
    await route.fulfill({ response: res, json: fleet })
  })
  await page.goto(`/routers/${routerId()}/interfaces`)
  await page.getByRole("button", { name: "Edit wan0" }).click()
  const form = page.getByRole("dialog")
  await form.getByLabel("MTU").fill("9000")
  await expect(form.getByTestId("interface-lines")).toHaveText("mtu 9000")
  await expect(form.getByTestId("interface-fields")).toHaveCount(0)
  await form.getByRole("button", { name: "Cancel" }).click()
})
