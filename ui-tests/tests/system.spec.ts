import { expect, test } from "@playwright/test"

import { linesRouterId, routerId } from "./helpers"

// The box itself (Prisma 0.149.25, #50): an administrator's, each action after the router's name.

async function routerName(request: import("@playwright/test").APIRequestContext, id: string): Promise<string> {
  const routers = (await (await request.get("/api/routers")).json()) as { id: string; name: string }[]
  return routers.find((r) => r.id === id)!.name
}

test("an upgrade is checked, confirmed by name and followed phase by phase into maintenance", async ({ page }) => {
  const name = await routerName(page.request, routerId())
  await page.goto(`/routers/${routerId()}/system`)
  const card = page.locator("[data-upgrade]")
  await card.getByRole("button", { name: "Check for a release" }).click()
  const upgrade = card.getByRole("button", { name: /^Upgrade to / })
  await expect(upgrade).toBeVisible()
  await upgrade.click()
  const dialog = page.getByRole("dialog")
  const go = dialog.getByRole("button", { name: "Upgrade", exact: true })
  await expect(go).toBeDisabled()
  await dialog.getByLabel(/Type .* to confirm/).fill(name)
  await go.click()
  await expect(card.locator('[data-phase="STARTED"]')).toBeVisible()
  await expect(card.locator('[data-phase="API_RESTART"]')).toBeVisible()
  await expect(card.getByText(/The API restarts now and is away for about/)).toBeVisible()
  await expect(page.locator("[data-maintenance]")).toContainText("upgrading")
})

test("a reboot needs the name, and an unsaved box can be rebooted anyway", async ({ page }) => {
  const name = await routerName(page.request, routerId())
  await page.goto(`/routers/${routerId()}/system`)
  await page.locator("[data-power]").getByRole("button", { name: "Reboot" }).click()
  const dialog = page.getByRole("dialog")
  const go = dialog.getByRole("button", { name: "Reboot", exact: true })
  await dialog.getByLabel(/Type .* to confirm/).fill("not-the-name")
  await expect(go).toBeDisabled()
  await dialog.getByLabel(/Type .* to confirm/).fill(name)
  await go.click()
  // The UI tests commit on this mock without saving: the box refuses until forced.
  const alert = dialog.getByRole("alert")
  const done = page.getByText("The box is rebooting.")
  await expect(alert.or(done)).toBeVisible()
  if (await alert.isVisible()) {
    await expect(alert).toContainText("Save it first, or go on anyway")
    await dialog.getByLabel("Go on anyway").click()
    await go.click()
  }
  await expect(page.getByText("The box is rebooting.")).toBeVisible()
  await expect(page.locator("[data-maintenance]")).toContainText("rebooting")
})

test("a router before 0.149.25 has no System tab", async ({ page }) => {
  await page.goto(`/routers/${linesRouterId()}/interfaces`)
  const tabs = page.getByRole("navigation", { name: "Router sections" })
  await expect(tabs.getByRole("link", { name: "Interfaces" })).toBeVisible()
  await expect(tabs.getByRole("link", { name: "System" })).toHaveCount(0)
})

test("a 0.149.26 router whose account has no operator says how to grant it, and the broken restart is not offered", async ({ page }) => {
  // prisma-mock-2: Prisma 0.149.26 without `operator` for prisma-web's account (#51).
  const res = await page.request.post("/api/routers", {
    data: { name: `ui-op-${Date.now()}`, api_url: "https://prisma-mock-2:50051", tls_profile: "dev/mock", tls_server_name: "prisma-api" },
  })
  expect(res.status()).toBe(201)
  const { id } = await res.json()
  try {
    await expect(async () => {
      const fleet = (await (await page.request.get("/api/routers/status")).json()) as { id: string; access: unknown; system_service: unknown }[]
      const me = fleet.find((r) => r.id === id)
      expect(me?.access && me.system_service).toBeTruthy()
    }).toPass({ timeout: 30_000 })
    await page.goto(`/routers/${id}/system`)
    const power = page.locator("[data-power]")
    await expect(power.locator("[data-grant]")).toContainText("operator")
    await expect(power.getByRole("button", { name: "Reboot" })).toBeDisabled()
    await expect(power.locator("[data-restart-broken]")).toBeVisible()
    // The check is every account's: it is offered and answers.
    await page.locator("[data-upgrade]").getByRole("button", { name: "Check for a release" }).click()
    await expect(page.locator("[data-upgrade]").getByText(/Newest:/)).toBeVisible()
  } finally {
    await page.request.delete(`/api/routers/${id}`)
  }
})
