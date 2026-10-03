import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

// On the line-only mock: the forms' line implementation, kept for boxes before the typed calls (#46).
import { linesRouterId as routerId, undoLastCommit } from "./helpers"

// Routing forms (#42, #43): every change is staged, reviewed and committed
// through ChangeReview; the tests commit only what they undo.

const R = () => `/api/routers/${routerId()}`

/** Opens the review of the staged changes and commits them, unconfirmed, acknowledging any gate. */
async function apply(page: Page) {
  await page.getByRole("button", { name: /Review and apply/ }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("passed")).toBeVisible()
  for (const gate of await dialog.locator("label").filter({ hasText: "I understand" }).getByRole("switch").all()) await gate.click()
  // The review resets its options when it opens: click until the switch stays off.
  const confirmed = dialog.getByRole("switch", { name: "Commit confirmed" })
  await expect(async () => {
    if ((await confirmed.getAttribute("aria-checked")) === "true") await confirmed.click()
    await expect(confirmed).toHaveAttribute("aria-checked", "false", { timeout: 1_000 })
    await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeVisible({ timeout: 1_000 })
  }).toPass()
  await dialog.getByRole("button", { name: "Apply", exact: true }).click()
  await expect(dialog).toBeHidden()
}

async function revisions(api: APIRequestContext) {
  return (await (await api.get(`${R()}/config/revisions`)).json()).revisions.length
}

/** Leaves the router without a neighbor a failed test may have left behind. */
async function dropNeighbor(api: APIRequestContext, peer: string) {
  const res = await api.get(`${R()}/config/running`, { timeout: 10_000 }).catch(() => null)
  if (!res?.ok()) return
  const running = (await res.json()).text as string
  const bgp = running.split("\n").find((l) => l.startsWith("router bgp "))
  if (!bgp || !running.includes(`neighbor ${peer} `)) return
  const c = await (await api.post(`${R()}/config/candidates`)).json()
  await api.post(`${R()}/config/candidates/${c.candidate_id}/edit`, { data: { path: [bgp], lines: [`no neighbor ${peer}`] } })
  await api.post(`${R()}/config/candidates/${c.candidate_id}/commit`, { data: { comment: "ui tests: cleanup", acknowledge_diverge: true } })
}

test("a BGP neighbor is added, shut down, edited from a prefilled form and removed", async ({ page }) => {
  const peer = "192.0.2.88"
  try {
    await page.goto(`/routers/${routerId()}/routing`)
    await page.getByRole("button", { name: "Add neighbor" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Address", { exact: true }).fill(peer)
    await dialog.getByLabel("Remote AS", { exact: true }).fill("nope")
    await expect(dialog.getByRole("button", { name: "Add to the changes" })).toBeDisabled()
    await dialog.getByLabel("Remote AS", { exact: true }).fill("64888")
    // FRR applies a family's route map in one direction: a bare name is refused (#47).
    const ipv4 = dialog.locator('[data-family="ipv4"]')
    await ipv4.getByLabel("Route map").fill("UI-RM")
    await expect(ipv4.getByText("the name, then in or out")).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Add to the changes" })).toBeDisabled()
    await ipv4.getByLabel("Route map").fill("")
    await dialog.getByLabel("Description", { exact: true }).fill("UI peer")
    await dialog.getByRole("button", { name: "Add to the changes" }).click()
    await expect(page.getByText(`neighbor ${peer} remote-as 64888 ; neighbor ${peer} description UI peer`)).toBeVisible()
    // A new IPv4 neighbor is activated in IPv4 unicast, in that family's mode.
    await expect(page.getByText(`neighbor ${peer} activate`, { exact: true })).toBeVisible()
    await apply(page)

    const row = page.locator(`tr[data-neighbor="${peer}"]`)
    await expect(row).toContainText("UI peer")
    await expect(row).toContainText("Established")

    await row.getByRole("button", { name: `Shut down ${peer}` }).click()
    await expect(page.getByText(`neighbor ${peer} shutdown`, { exact: true })).toBeVisible()
    await apply(page)
    await expect(row).toContainText("Idle (Admin)")

    await row.getByRole("button", { name: `Edit ${peer}` }).click()
    await expect(dialog.getByLabel("Remote AS", { exact: true })).toHaveValue("64888")
    await expect(dialog.getByLabel("Shut down", { exact: true })).toBeChecked()
    await expect(dialog.getByLabel("Activate in IPv4 unicast")).toBeChecked()
    await dialog.getByLabel("Remote AS", { exact: true }).fill("64889")
    await dialog.getByLabel("Shut down", { exact: true }).click()
    await dialog.getByRole("button", { name: "Add to the changes" }).click()
    // remote-as is replaced by its new line alone: `no neighbor … remote-as` would remove the neighbor.
    await expect(page.getByText(`neighbor ${peer} remote-as 64889 ; no neighbor ${peer} shutdown`, { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Discard all" }).click()

    await row.getByRole("button", { name: `Remove ${peer}` }).click()
    await expect(page.getByText(`no neighbor ${peer}`, { exact: true })).toBeVisible()
    await apply(page)
    await expect(row).toHaveCount(0)
  } finally {
    await dropNeighbor(page.request, peer)
  }
})

test("networks, aggregates and redistribution are staged per address family, nothing committed", async ({ page }) => {
  const before = await revisions(page.request)
  await page.goto(`/routers/${routerId()}/routing`)
  await page.getByRole("tab", { name: "IPv6 unicast" }).click()
  const v6 = page.locator('[data-family-panel="ipv6"]')
  // The seeded IPv6 neighbor is active in this family.
  await expect(v6.getByText("2001:db8:100::1")).toBeVisible()
  await v6.getByLabel("Prefix", { exact: true }).fill("192.0.2.0/24")
  await expect(v6.getByRole("button", { name: "Add network" })).toBeDisabled()
  await v6.getByLabel("Prefix", { exact: true }).fill("2001:db8:88::/48")
  await v6.getByRole("button", { name: "Add network" }).click()
  await v6.getByLabel("Aggregate prefix").fill("2001:db8:80::/41")
  await v6.getByLabel("Summary only").click()
  await v6.getByRole("button", { name: "Add aggregate" }).click()
  await v6.locator('[data-redistribute="static"]').getByRole("button", { name: "Turn on" }).click()

  // Each goes to the IPv6 family's mode.
  for (const line of ["network 2001:db8:88::/48", "aggregate-address 2001:db8:80::/41 summary-only", "redistribute static"]) {
    const row = page.locator("[data-staged]", { hasText: line })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText("router bgp 65000 › address-family ipv6 unicast")
  }

  await page.getByRole("button", { name: /Review and apply \(3\)/ }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText(/\+\s+network 2001:db8:88::\/48/)).toBeVisible()
  await expect(dialog.getByText(/\+\s+redistribute static/)).toBeVisible()
  await dialog.getByRole("button", { name: "Discard" }).click()
  expect(await revisions(page.request)).toBe(before)
})

test("OSPF and OSPF6 networks, areas, passive interfaces and redistribution reach the router", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/routing`)
  const v2 = page.locator('[data-ospf="ospf"]')
  await expect(v2.getByText("network 192.168.10.0/24 area 0")).toBeVisible()
  await v2.getByLabel("Network", { exact: true }).fill("10.88.0.0/16")
  await v2.getByLabel("Network area").fill("0.0.0.1")
  await v2.getByRole("button", { name: "Add network" }).click()
  await v2.getByRole("button", { name: "Edit ospf on wan0" }).click()
  let dialog = page.getByRole("dialog")
  await dialog.getByLabel("Passive (no hellos sent)").click()
  await dialog.getByRole("button", { name: "Add to the changes" }).click()
  await expect(page.getByText("passive-interface wan0", { exact: true })).toBeVisible()

  await page.getByRole("tab", { name: "OSPFv3 (ospf6)" }).click()
  const v3 = page.locator('[data-ospf="ospf6"]')
  await v3.getByLabel("Area", { exact: true }).fill("0.0.0.1")
  await v3.getByLabel("No summary").click()
  await v3.getByRole("button", { name: "Add area" }).click()
  await v3.getByRole("button", { name: "Edit ospf6 on wan0" }).click()
  dialog = page.getByRole("dialog")
  await dialog.getByLabel("Area", { exact: true }).fill("0")
  await dialog.getByLabel("Passive (no hellos sent)").click()
  await dialog.getByRole("button", { name: "Add to the changes" }).click()
  await expect(page.getByText("ipv6 ospf6 area 0 ; ipv6 ospf6 passive", { exact: true })).toBeVisible()
  const redis = v3.locator('[data-redistribute="connected"]')
  await redis.getByRole("switch").click()
  await redis.getByLabel("Route map").fill("RM-V6")
  await redis.getByRole("button", { name: "Add to the changes" }).click()
  await expect(page.getByText("redistribute connected route-map RM-V6", { exact: true })).toBeVisible()

  await apply(page)
  try {
    const wan = v3.locator('tr[data-interface="wan0"]')
    await expect(wan).toContainText("0")
    await expect(wan).toContainText("passive")
    await expect(v3.getByText("area 0.0.0.1 stub no-summary", { exact: true })).toBeVisible()
    await page.getByRole("tab", { name: "OSPFv2" }).click()
    await expect(v2.getByText("network 10.88.0.0/16 area 0.0.0.1")).toBeVisible()
    await expect(v2.locator('tr[data-interface="wan0"]')).toContainText("passive")
  } finally {
    await undoLastCommit(page.request, routerId())
  }
})

test("static routes are added and removed, IPv4 and IPv6, through an address or an interface", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/routing`)
  await page.getByRole("button", { name: "Add route" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Prefix", { exact: true }).fill("198.51.100.0/24")
  await dialog.getByLabel("Next hop", { exact: true }).fill("2001:db8::1")
  await expect(dialog.getByText("an address of the prefix's family")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Add to the changes" })).toBeDisabled()
  await dialog.getByLabel("Next hop", { exact: true }).fill("203.0.113.9")
  await dialog.getByLabel("Distance", { exact: true }).fill("200")
  await dialog.getByRole("button", { name: "Add to the changes" }).click()

  await page.getByRole("button", { name: "Add route" }).click()
  await dialog.getByLabel("Prefix", { exact: true }).fill("2001:db8:99::/48")
  await dialog.getByLabel("Next hop", { exact: true }).fill("wan0")
  await dialog.getByLabel("Description", { exact: true }).fill("via the uplink")
  await dialog.getByRole("button", { name: "Add to the changes" }).click()
  await expect(page.getByText("2001:db8:99::/48 next-hop wan0 description via the uplink", { exact: true })).toBeVisible()
  await apply(page)

  const v4 = page.locator('tr[data-route="198.51.100.0/24"]')
  const v6 = page.locator('tr[data-route="2001:db8:99::/48"]')
  try {
    await expect(v4).toContainText("203.0.113.9")
    await expect(v4).toContainText("200")
    await expect(v6).toContainText("IPv6")
    await expect(v6).toContainText("wan0")
  } finally {
    await page.getByRole("button", { name: "Remove route 198.51.100.0/24 via 203.0.113.9" }).click()
    await page.getByRole("button", { name: "Remove route 2001:db8:99::/48 via wan0" }).click()
    await expect(page.getByText("no 198.51.100.0/24 next-hop 203.0.113.9 distance 200", { exact: true })).toBeVisible()
    await apply(page)
  }
  await expect(v4).toHaveCount(0)
  await expect(v6).toHaveCount(0)
})

test("a viewer sees the routing configuration but is offered no form", async ({ page, browser, baseURL }) => {
  const name = `ui-view-${Date.now().toString(36)}`
  const password = `pw-${Math.random().toString(36).slice(2)}-x`
  const created = await page.request.post("/api/users", { data: { username: name, password, role: "viewer" } })
  expect(created.ok()).toBeTruthy()
  const { id: userId } = await created.json()
  const ctx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  try {
    expect((await ctx.request.post("/api/auth/login", { data: { username: name, password } })).ok()).toBeTruthy()
    const p = await ctx.newPage()
    await p.goto(`/routers/${routerId()}/routing`)
    await expect(p.locator('tr[data-neighbor="203.0.113.9"]')).toContainText("Established")
    await expect(p.locator('tr[data-route="0.0.0.0/0"]')).toBeVisible()
    await expect(p.getByRole("button", { name: "Add neighbor" })).toHaveCount(0)
    await expect(p.getByRole("button", { name: "Add route" })).toHaveCount(0)
    await expect(p.getByRole("button", { name: /^Edit / })).toHaveCount(0)
    await expect(p.getByRole("button", { name: /^Remove / })).toHaveCount(0)
  } finally {
    await ctx.close()
    await page.request.delete(`/api/users/${userId}`)
  }
})
