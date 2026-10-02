import { expect, test } from "@playwright/test"

import { routerId } from "./helpers"

test("router access set on the Users screen hides the router from that user", async ({ page, browser, baseURL }) => {
  const name = `ui-acc-${Date.now().toString(36)}`
  const password = `pw-${Math.random().toString(36).slice(2)}-x`
  const created = await page.request.post("/api/users", { data: { username: name, password, role: "operator" } })
  expect(created.ok()).toBeTruthy()
  const { id: userId } = await created.json()
  try {
    await page.goto("/users")
    await page.getByRole("button", { name: `Actions for ${name}` }).click()
    await page.getByRole("menuitem", { name: "Router access" }).click()
    const dialog = page.getByRole("dialog")
    const routerName = (await (await page.request.get(`/api/routers/${routerId()}`)).json()).name
    await dialog.getByRole("combobox", { name: `Access to ${routerName}` }).click()
    await page.getByRole("option", { name: "No access" }).click()
    await expect(page.getByText(`${name} on ${routerName}: No access`)).toBeVisible()

    // As that user, the router is gone from the list and its pages.
    const ctx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
    const login = await ctx.request.post("/api/auth/login", { data: { username: name, password } })
    expect(login.ok()).toBeTruthy()
    const routers = await (await ctx.request.get("/api/routers")).json()
    expect(routers.map((r: { id: string }) => r.id)).not.toContain(routerId())
    expect((await ctx.request.get(`/api/routers/${routerId()}/system`)).status()).toBe(404)
    await ctx.close()
  } finally {
    await page.request.delete(`/api/users/${userId}`)
  }
})
