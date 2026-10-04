import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

// On the line-only mock: the forms' line implementation, kept for boxes before the typed calls (#46).
import { linesRouterId as routerId } from "./helpers"

// CGNAT forms (#41) on the plain mock: pools, the global settings and the log
// collectors, each staged, reviewed and, where the test says so, committed.

/** The card listing what is staged. */
const stagedCard = (page: Page) => page.locator("[data-slot=card]", { has: page.locator("[data-slot=card-title]", { hasText: "Changes to review" }) })

const revisions = async (api: APIRequestContext, id = routerId()) =>
  (await (await api.get(`/api/routers/${id}/config/revisions`)).json()).revisions.length as number

/** Puts the mock back on the revision before `made` commits. */
async function rollBack(api: APIRequestContext, made: number) {
  if (made <= 0) return
  const R = `/api/routers/${routerId()}/config`
  const c = await (await api.post(`${R}/candidates`, { data: { from_revision: made } })).json()
  const res = await api.post(`${R}/candidates/${c.candidate_id}/commit`, { data: { comment: "ui tests: undo", acknowledge_remap: true } })
  if (!res.ok()) throw new Error(`undo failed: ${res.status()} ${await res.text()}`)
}

/** Opens the review of what is staged and applies it without commit confirmed. */
async function reviewAndApply(page: Page, staged: number, acknowledgeRemap = false) {
  await page.getByRole("button", { name: `Review and apply (${staged})` }).click()
  const review = page.getByRole("dialog")
  await expect(review.getByRole("heading", { name: "What changes" })).toBeVisible()
  if (acknowledgeRemap) {
    await expect(review.getByText("This change requires acknowledgment")).toBeVisible()
    await review.getByRole("switch").first().click()
  }
  // The review keeps the last choice; apply without the confirmation window.
  const confirmed = review.getByRole("switch", { name: "Commit confirmed" })
  if ((await confirmed.getAttribute("aria-checked")) === "true") await confirmed.click()
  await review.getByRole("button", { name: "Apply", exact: true }).click()
  await expect(review).toBeHidden()
}

test("a pool is created, edited and removed from the forms", async ({ page }) => {
  const before = await revisions(page.request)
  try {
    await page.goto(`/routers/${routerId()}/cgnat`)
    await page.getByRole("button", { name: "Add a pool" }).click()
    const form = page.getByRole("dialog")
    await form.getByLabel("Name").fill("UI41")
    await form.getByRole("button", { name: "Add an inside prefix" }).click()
    await form.getByLabel("Inside prefixes 1").fill("10.41.0.0/300")
    await expect(form.getByText("an IPv4 prefix (A.B.C.D/M)")).toBeVisible()
    await expect(form.getByRole("button", { name: "Add to the changes" })).toBeDisabled()
    await form.getByLabel("Inside prefixes 1").fill("10.41.0.0/16")
    await form.getByRole("button", { name: "Add an outside prefix" }).click()
    await form.getByLabel("Outside prefixes 1").fill("198.51.100.0/28")
    await form.getByLabel("Block size (ports)").fill("512")
    await form.getByRole("combobox", { name: "SIP" }).click()
    await page.getByRole("option", { name: "Off" }).click()
    await expect(form.getByTestId("lines-preview")).toHaveText(
      ["prefix-inside 10.41.0.0/16", "prefix-outside 198.51.100.0/28", "block-size 512", "alg sip off"].join("\n"),
    )
    // A new pool remaps nobody: nothing to explain.
    await expect(form.getByRole("note")).toBeHidden()
    await form.getByRole("button", { name: "Add to the changes" }).click()
    await expect(stagedCard(page)).toBeVisible()
    await reviewAndApply(page, 1)

    // The box reports the pool once committed; the form opens it prefilled.
    const row = page.getByRole("row", { name: /UI41/ })
    await expect(row.getByText("198.51.100.0/28")).toBeVisible()
    await page.getByRole("button", { name: "Edit pool UI41" }).click()
    await expect(form.getByLabel("Block size (ports)")).toHaveValue("512")
    await form.getByLabel("Max blocks a subscriber").fill("4")
    await expect(form.getByTestId("lines-preview")).toHaveText("max-blocks 4")
    await form.getByRole("button", { name: "Add to the changes" }).click()
    await reviewAndApply(page, 1)
    await expect.poll(async () => (await (await page.request.get(`/api/routers/${routerId()}/config/running`)).json()).text).toContain("max-blocks 4")

    await page.getByRole("button", { name: "Remove pool UI41" }).click()
    await expect(stagedCard(page).getByText(/Removing the pool remaps its subscribers/)).toBeVisible()
    await reviewAndApply(page, 1, true)
    await expect(page.getByRole("row", { name: /UI41/ })).toBeHidden()
  } finally {
    await rollBack(page.request, (await revisions(page.request)) - before)
  }
})

test("a new block size explains the remap before the review, and the review gates it", async ({ page }) => {
  const before = await revisions(page.request)
  await page.goto(`/routers/${routerId()}/cgnat`)
  await page.getByRole("button", { name: "Edit pool RFC6598" }).click()
  const form = page.getByRole("dialog")
  await expect(form.getByLabel("Block size (ports)")).toHaveValue("256")
  await expect(form.getByRole("note")).toBeHidden()
  await form.getByLabel("Block size (ports)").fill("1024")
  await expect(form.getByRole("note")).toContainText("Changing the block size remaps subscribers")
  await form.getByRole("button", { name: "Add to the changes" }).click()
  await expect(stagedCard(page).getByText(/Changing the block size remaps subscribers/)).toBeVisible()

  await page.getByRole("button", { name: "Review and apply (1)" }).click()
  const review = page.getByRole("dialog")
  await expect(review.getByText("This change requires acknowledgment")).toBeVisible()
  await expect(review.getByRole("button", { name: /^Apply/ })).toBeDisabled()
  await review.getByRole("button", { name: "Discard" }).click()
  expect(await revisions(page.request)).toBe(before)
})

test("collectors set from the form show in the log export card after the commit", async ({ page }) => {
  const before = await revisions(page.request)
  try {
    await page.goto(`/routers/${routerId()}/cgnat`)
    const card = page.locator("[data-slot=card]", { has: page.locator("[data-slot=card-title]", { hasText: /^Log export/ }) })
    await expect(card.getByRole("row", { name: /IPFIX over TCP/ })).toContainText("not configured")

    await page.getByRole("button", { name: "Edit collectors" }).click()
    const tcp = page.getByRole("dialog").getByRole("region", { name: "IPFIX over TCP" })
    await tcp.getByRole("combobox", { name: "IPFIX over TCP" }).click()
    await page.getByRole("option", { name: "Send to a collector" }).click()
    await tcp.getByLabel("Collector").fill("192.0.2.71")
    await tcp.getByLabel("Port").fill("4741")
    await expect(page.getByTestId("lines-preview")).toHaveText("logging tcp 192.0.2.71 port 4741")
    await page.getByRole("button", { name: "Add to the changes" }).click()
    await reviewAndApply(page, 1)

    await expect(card.getByRole("row", { name: /IPFIX over TCP/ })).toContainText("192.0.2.71:4741")
    await expect(page.locator("[data-slot=card]", { hasText: "Log collectors" }).getByText("192.0.2.71 port 4741")).toBeVisible()
  } finally {
    await rollBack(page.request, (await revisions(page.request)) - before)
  }
})

test("disabling a syslog that was never enabled is explained first and its refusal shown in the review", async ({ page }) => {
  const before = await revisions(page.request)
  await page.goto(`/routers/${routerId()}/cgnat`)
  await page.getByRole("button", { name: "Edit collectors" }).click()
  const form = page.getByRole("dialog")
  await form.getByRole("combobox", { name: "Syslog (TCP)" }).click()
  await page.getByRole("option", { name: "Disabled" }).click()
  await expect(form.getByRole("note")).toContainText("Syslog was never enabled on this router")
  await form.getByRole("button", { name: "Add to the changes" }).click()
  await expect(stagedCard(page).getByText(/Syslog was never enabled on this router/)).toBeVisible()

  await page.getByRole("button", { name: "Review and apply (1)" }).click()
  const review = page.getByRole("dialog")
  await expect(review.getByText("+  logging syslog disable")).toBeVisible()
  const confirmed = review.getByRole("switch", { name: "Commit confirmed" })
  if ((await confirmed.getAttribute("aria-checked")) === "true") await confirmed.click()
  await review.getByRole("button", { name: "Apply", exact: true }).click()
  // The back refuses it on the mock (0.149.0-mock, before 0.149.8), with the reason (#31).
  const refusal = review.getByRole("alert")
  await expect(refusal).toContainText(/before 0\.149\.8\), disabling a syslog that was never enabled stops the dataplane/)
  await expect(refusal).toBeInViewport()
  await review.getByRole("button", { name: "Discard" }).click()
  expect(await revisions(page.request)).toBe(before)
})

test("a cgnat-operator gets the CGNAT forms and nothing else; a read-only login gets none", async ({ page }) => {
  const register = async (profile: string) => {
    const r = await page.request.post("/api/routers", {
      data: { name: `ui-${profile.split("/")[1]}-${Date.now().toString(36)}`, api_url: "https://prisma-mock-2:50051", tls_profile: profile, tls_server_name: "prisma-api" },
    })
    expect(r.ok()).toBeTruthy()
    return (await r.json()).id as string
  }
  const cgnat = await register("dev/cgnat")
  const ro = await register("dev/readonly")
  try {
    await page.goto(`/routers/${cgnat}/cgnat`)
    await expect(page.getByText("cgnat-ops · cgnat-operator")).toBeVisible()
    for (const b of ["Edit settings", "Edit collectors", "Add a pool", "Edit pool RFC6598"]) await expect(page.getByRole("button", { name: b })).toBeVisible()
    // Outside nat > cgnat the same account changes nothing.
    await page.goto(`/routers/${cgnat}/settings?at=${encodeURIComponent("interface lan0")}`)
    await expect(page.getByText(/read-only for you/)).toBeVisible()
    await page.goto(`/routers/${cgnat}/settings?at=${encodeURIComponent("nat > cgnat > pool RFC6598")}`)
    await expect(page.getByRole("button", { name: "Add a setting" })).toBeVisible()

    await page.goto(`/routers/${ro}/cgnat`)
    await expect(page.getByText("noc · read-only")).toBeVisible()
    await expect(page.locator("[data-slot=card-title]", { hasText: /^Log collectors/ })).toBeVisible()
    for (const b of ["Edit settings", "Edit collectors", "Add a pool"]) await expect(page.getByRole("button", { name: b })).toHaveCount(0)
  } finally {
    await page.request.delete(`/api/routers/${cgnat}`)
    await page.request.delete(`/api/routers/${ro}`)
  }
})

test("an IPv6 inside prefix makes a NAT64 pool: subscriber length and NAT64 prefix, no ALG (#59)", async ({ page }) => {
  await page.goto(`/routers/${routerId()}/cgnat`)
  await page.getByRole("button", { name: "Add a pool" }).click()
  const form = page.getByRole("dialog")
  await form.getByLabel("Name").fill("UI64")
  await form.getByRole("button", { name: "Add an inside prefix" }).click()
  await form.getByLabel("Inside prefixes 1").fill("2001:db8:1400::/40")
  await form.getByRole("button", { name: "Add an outside prefix" }).click()
  await form.getByLabel("Outside prefixes 1").fill("198.51.100.96/28")
  await expect(form.locator("[data-nat64]")).toBeVisible()
  await expect(form.getByRole("combobox", { name: "SIP" })).toHaveCount(0)
  await expect(form.getByText("A NAT64 pool takes no application gateway")).toBeVisible()
  await form.getByLabel("Subscriber prefix length").fill("200")
  await expect(form.getByRole("button", { name: "Add to the changes" })).toBeDisabled()
  await form.getByLabel("Subscriber prefix length").fill("56")
  await expect(form.getByTestId("lines-preview")).toHaveText(
    ["prefix-inside 2001:db8:1400::/40", "prefix-outside 198.51.100.96/28", "subscriber-length 56"].join("\n"),
  )
  // Back to IPv4: the NAT64 fields go away.
  await form.getByLabel("Inside prefixes 1").fill("10.64.0.0/16")
  await expect(form.locator("[data-nat64]")).toHaveCount(0)
  await form.getByRole("button", { name: "Cancel" }).click()
})
