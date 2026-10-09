import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

import { routerId } from "./helpers"

// The forms on the typed configuration (Prisma 0.149.22, #46), on the plain
// mock, which answers GetConfig, SetConfig and DeleteConfig: each form sends
// fields, the router writes the lines, and the review shows them before the
// diff. The same forms on the line-only mock are interfaces.spec.ts,
// cgnat-forms.spec.ts and routing.spec.ts.

const R = () => `/api/routers/${routerId()}`
const SECRET = "ui-Secret-46"

const revisions = async (api: APIRequestContext) => (await (await api.get(`${R()}/config/revisions`)).json()).revisions.length as number

/** Puts the mock back on the revision before `made` commits. */
async function rollBack(api: APIRequestContext, made: number) {
  if (made <= 0) return
  const c = await (await api.post(`${R()}/config/candidates`, { data: { from_revision: made } })).json()
  const res = await api.post(`${R()}/config/candidates/${c.candidate_id}/commit`, {
    data: { comment: "ui tests: undo", acknowledge_remap: true, acknowledge_diverge: true },
  })
  if (!res.ok()) throw new Error(`undo failed: ${res.status()} ${await res.text()}`)
}

/** The "Lines the router wrote" section of the open review, as text. */
const boxLines = (page: Page) => page.getByRole("dialog").getByTestId("typed-staged")

async function apply(page: Page) {
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("passed")).toBeVisible()
  for (const gate of await dialog.locator("label").filter({ hasText: "I understand" }).getByRole("switch").all()) await gate.click()
  const confirmed = dialog.getByRole("switch", { name: "Commit confirmed" })
  await expect(async () => {
    if ((await confirmed.getAttribute("aria-checked")) === "true") await confirmed.click()
    await expect(confirmed).toHaveAttribute("aria-checked", "false", { timeout: 1_000 })
  }).toPass()
  await dialog.getByRole("button", { name: "Apply", exact: true }).click()
  await expect(dialog).toBeHidden()
}

test("the interface form sends the MTU as one named field and the review shows the line the router wrote", async ({ page }) => {
  const before = await revisions(page.request)
  await page.goto(`/routers/${routerId()}/interfaces`)
  await page.getByRole("button", { name: "Edit wan0" }).click()
  const form = page.getByRole("dialog")
  await expect(form.getByLabel("Description")).toHaveValue("Carrier uplink")
  await form.getByLabel("MTU").fill("9000")
  // Fields, not lines: the router writes them.
  await expect(form.getByTestId("interface-fields")).toHaveText("mtu 9000")
  await form.getByRole("button", { name: "Add to the changes" }).click()
  const staged = page.locator("[data-staged]", { hasText: "mtu 9000" })
  await expect(staged).toContainText("fields")

  await page.getByRole("button", { name: /Review and apply \(1\)/ }).click()
  // Only the field named: the description, addresses and the rest are untouched.
  await expect(boxLines(page)).toContainText("interface wan0")
  await expect(boxLines(page).locator("pre")).toHaveText("mtu 9000")
  await expect(page.getByRole("dialog").getByText(/\+\s+mtu 9000/)).toBeVisible()
  await page.getByRole("dialog").getByRole("button", { name: "Discard" }).click()
  expect(await revisions(page.request)).toBe(before)
})

test("a pool's block size is set as a field, with the remap warning and gate kept", async ({ page }) => {
  const before = await revisions(page.request)
  await page.goto(`/routers/${routerId()}/cgnat`)
  await page.getByRole("button", { name: "Edit pool RFC6598" }).click()
  const form = page.getByRole("dialog")
  await expect(form.getByLabel("Block size (ports)")).toHaveValue("256")
  await form.getByLabel("Block size (ports)").fill("512")
  await expect(form.getByText("Fields for the router")).toBeVisible()
  await expect(form.getByTestId("lines-preview")).toHaveText("block_size 512")
  await expect(form.getByRole("note")).toContainText("remaps subscribers")
  await form.getByRole("button", { name: "Add to the changes" }).click()

  await page.getByRole("button", { name: /Review and apply \(1\)/ }).click()
  await expect(boxLines(page).locator("pre")).toHaveText("block-size 512")
  // The gate the line form meets is met here too.
  await expect(page.getByRole("dialog").getByText("This change requires acknowledgment")).toBeVisible()
  await page.getByRole("dialog").getByRole("button", { name: "Discard" }).click()
  expect(await revisions(page.request)).toBe(before)
})

test("a BGP neighbor is added with a write-only password, edited and removed statement by statement", async ({ page }) => {
  const peer = "192.0.2.146"
  const before = await revisions(page.request)
  try {
    // A router-level statement no field takes is listed read only.
    const c = await (await page.request.post(`${R()}/config/candidates`, { data: {} })).json()
    await page.request.post(`${R()}/config/candidates/${c.candidate_id}/edit`, { data: { path: ["router bgp 65000"], lines: ["timers bgp 10 30"] } })
    expect((await page.request.post(`${R()}/config/candidates/${c.candidate_id}/commit`, { data: { comment: "ui tests: other" } })).ok()).toBeTruthy()

    await page.goto(`/routers/${routerId()}/routing/bgp`)
    const other = page.getByRole("region", { name: "Other statements of router bgp 65000" })
    await expect(other).toContainText("timers bgp 10 30")
    await expect(other.getByRole("button")).toHaveCount(0)

    await page.getByRole("button", { name: "Add neighbor" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Address", { exact: true }).fill(peer)
    await dialog.getByLabel("Remote AS", { exact: true }).fill("64946")
    await dialog.getByLabel("Password", { exact: true }).fill(SECRET)
    await dialog.getByLabel("Route map in (ipv4)").fill("UI-IN")
    await expect(dialog.getByTestId("neighbor-fields")).toContainText("password (set, not shown)")
    await expect(dialog.getByTestId("neighbor-fields")).not.toContainText(SECRET)
    await dialog.getByRole("button", { name: "Add to the changes" }).click()
    await expect(page.locator("[data-staged]", { hasText: `neighbor ${peer}` })).toContainText("password (set, not shown)")

    await page.getByRole("button", { name: /Review and apply/ }).click()
    await expect(boxLines(page)).toContainText(`neighbor ${peer} remote-as 64946`)
    await expect(boxLines(page)).toContainText(`neighbor ${peer} password <set, not shown>`)
    await expect(boxLines(page)).toContainText(`neighbor ${peer} route-map UI-IN in`)
    expect(await page.content()).not.toContain(SECRET)
    await apply(page)

    const row = page.locator(`tr[data-neighbor="${peer}"]`)
    await expect(row).toContainText("password")
    await row.getByRole("button", { name: `Edit ${peer}` }).click()
    // Never read back: the field is empty, the box only says one is set.
    await expect(dialog.getByLabel("Password", { exact: true })).toHaveValue("")
    await expect(dialog.getByTestId("password-set")).toBeVisible()
    await expect(dialog.getByLabel("Route map in (ipv4)")).toHaveValue("UI-IN")
    await dialog.getByLabel("Description", { exact: true }).fill("UI typed")
    // Only the description is named: an empty password is not sent, so it is kept.
    await expect(dialog.getByTestId("neighbor-fields")).toHaveText(`neighbor ${peer}:\ndescription UI typed`)
    await dialog.getByRole("button", { name: "Cancel" }).click()

    await row.getByRole("button", { name: `Remove ${peer}` }).click()
    await expect(page.locator("[data-staged]", { hasText: `remove neighbor ${peer}` })).toBeVisible()
    await page.getByRole("button", { name: /Review and apply/ }).click()
    const removal = boxLines(page).locator("pre")
    await expect(removal).toContainText(`no neighbor ${peer} route-map UI-IN in`)
    const text = await removal.innerText()
    const lines = text.split("\n").map((l) => l.trim())
    expect(lines.at(-1)).toBe(`no neighbor ${peer} remote-as 64946`)
    expect(lines).not.toContain(`no neighbor ${peer}`)
    expect(lines.indexOf("address-family ipv4 unicast")).toBe(0)
    await apply(page)
    await expect(row).toHaveCount(0)
  } finally {
    await rollBack(page.request, (await revisions(page.request)) - before)
  }
})

test("removing a peer-group its members still name is refused, and the refusal names them", async ({ page }) => {
  const before = await revisions(page.request)
  try {
    const c = await (await page.request.post(`${R()}/config/candidates`, { data: {} })).json()
    await page.request.post(`${R()}/config/candidates/${c.candidate_id}/edit`, {
      data: { path: ["router bgp 65000"], lines: ["neighbor UI-GROUP peer-group", "neighbor UI-GROUP remote-as 64947", "neighbor 192.0.2.147 peer-group UI-GROUP"] },
    })
    expect((await page.request.post(`${R()}/config/candidates/${c.candidate_id}/commit`, { data: { comment: "ui tests: peer group" } })).ok()).toBeTruthy()

    await page.goto(`/routers/${routerId()}/routing/bgp`)
    const group = page.locator('tr[data-neighbor="UI-GROUP"]')
    await expect(group).toContainText("peer group")
    await group.getByRole("button", { name: "Remove UI-GROUP" }).click()
    await page.getByRole("button", { name: /Review and apply/ }).click()
    // Nothing staged: the review does not open, the refusal says which change and which members.
    await expect(page.getByTestId("refusal")).toContainText("remove UI-GROUP")
    await expect(page.getByText(/peer-group UI-GROUP is still used by 192\.0\.2\.147/)).toBeVisible()
    await expect(page.getByRole("dialog")).toHaveCount(0)
  } finally {
    await rollBack(page.request, (await revisions(page.request)) - before)
  }
})
