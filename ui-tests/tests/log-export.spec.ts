import { expect, test } from "@playwright/test"

test("the CGNAT tab shows the log export and a stall reaches the router page", async ({ page }) => {
  // prisma-mock-2 has all three CGNAT log streams configured (Prisma 0.149.15).
  const created = await page.request.post("/api/routers", {
    data: { name: `ui-log-${Date.now().toString(36)}`, api_url: "https://prisma-mock-2:50051", tls_profile: "dev/mock", tls_server_name: "prisma-api" },
  })
  expect(created.ok()).toBeTruthy()
  const { id } = await created.json()
  try {
    await page.goto(`/routers/${id}/cgnat`)
    // The title also holds the state badge, so match the title by its start.
    const card = page.locator("[data-slot=card]", { has: page.locator("[data-slot=card-title]", { hasText: /^Log export/ }) })
    const title = card.locator("[data-slot=card-title]")
    await expect(title.getByText("delivering", { exact: true })).toBeVisible()
    for (const s of ["Syslog (TCP)", "IPFIX over TCP", "IPFIX over UDP"]) await expect(card.getByText(s)).toBeVisible()

    // Events are not replayed: wait until prisma-web's telemetry stream to the new router is up.
    await expect
      .poll(async () => (await (await page.request.get(`/api/routers/${id}/metrics/traffic?interface=wan0&minutes=5`)).json()).live, { timeout: 20_000 })
      .toBe(true)
    await page.request.post(`/api/routers/${id}/show`, { data: { command: "mock log-export stall" } })
    // The fleet monitor (5 s) and the card (10 s) pick it up.
    await expect(page.getByText(/The CGNAT log export is stalled/)).toBeVisible({ timeout: 20_000 })
    await expect(title.getByText("1 stalled")).toBeVisible({ timeout: 20_000 })
    await expect(card.getByText("log-stalled")).toBeVisible({ timeout: 20_000 })
  } finally {
    await page.request.post(`/api/routers/${id}/show`, { data: { command: "mock log-export deliver" } })
    await page.request.delete(`/api/routers/${id}`)
  }
})
