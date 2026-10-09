import { expect, test, type Page } from "@playwright/test"

import { routerId } from "./helpers"

// At a phone's width (#80): no page scrolls sideways, every router tab is in sight, a wide table
// shows it scrolls, and the widest tables keep their key columns on the screen.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

const WIDTH = 390

async function noSidewaysScroll(page: Page, url: string) {
  await page.goto(url)
  // The page's cards fill in over a moment; overflow is measured once they have.
  await page.waitForTimeout(2500)
  const { scroll, client, wide } = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    // What sticks out, to say in the failure.
    const wide = Array.from(document.querySelectorAll("main *"))
      .filter((e) => e.getBoundingClientRect().right > vw + 1 && Array.from(e.children).every((c) => c.getBoundingClientRect().right <= vw + 1))
      .slice(0, 3)
      .map((e) => `${e.tagName.toLowerCase()}.${(e.getAttribute("class") ?? "").slice(0, 60)} "${(e.textContent ?? "").slice(0, 30)}"`)
    return { scroll: document.documentElement.scrollWidth, client: vw, wide }
  })
  console.log(url, scroll, wide.join(" | "))
  expect(scroll, `${url} scrolls sideways`).toBeLessThanOrEqual(client)
}

/** The header cell's right edge is on the screen. */
async function inSight(page: Page, scope: string, header: string) {
  const th = page.locator(scope).locator("th", { hasText: new RegExp(`^${header}$`) }).first()
  await expect(th).toBeVisible()
  const box = await th.boundingBox()
  expect(box && box.x + box.width, `${header} is out of sight`).toBeLessThanOrEqual(WIDTH)
}

test("no page scrolls sideways on a phone", async ({ page }) => {
  test.setTimeout(180_000)
  const id = routerId()
  for (const url of ["/", "/routers", "/audit", "/users", `/routers/${id}`, `/routers/${id}/interfaces`, `/routers/${id}/config`, `/routers/${id}/settings`,
    `/routers/${id}/cgnat`, `/routers/${id}/routing`, ...["static", "bgp", "ospf", "isis", "bfd", "vrrp", "logging"].map((p) => `/routers/${id}/routing/${p}`), `/routers/${id}/policies`, `/routers/${id}/policies/prefix-lists`, `/routers/${id}/policies/communities`, `/routers/${id}/console`, `/routers/${id}/system`]) {
    await noSidewaysScroll(page, url)
  }
})

test("every router tab is in sight on a phone", async ({ page }) => {
  await page.goto(`/routers/${routerId()}`)
  const tabs = page.getByRole("navigation", { name: "Router sections" }).getByRole("link")
  await expect(tabs.first()).toBeVisible()
  const n = await tabs.count()
  expect(n).toBeGreaterThan(5)
  for (let i = 0; i < n; i++) {
    const box = await tabs.nth(i).boundingBox()
    expect(box && box.x + box.width, `tab ${await tabs.nth(i).textContent()} is out of sight`).toBeLessThanOrEqual(WIDTH)
  }
})

test("the widest tables keep their key columns in sight, and a wide table shows it scrolls", async ({ page }) => {
  const id = routerId()
  await page.goto(`/routers/${id}/interfaces`)
  await inSight(page, "main", "State")
  await expect(page.locator("th", { hasText: /^Received$/ })).toBeHidden()
  // A table still wider than its card shows a shadow on the side it scrolls to.
  const shadow = await page.locator("[data-slot=table-container]").first().evaluate((e) => getComputedStyle(e).backgroundImage)
  expect(shadow).toContain("radial-gradient")

  await page.goto("/routers")
  await inSight(page, "main", "State")
  await page.goto(`/routers/${id}/cgnat`)
  await inSight(page, "main", "Actions")
  await inSight(page, "main", "Subscribers")
  await page.goto(`/routers/${id}/routing/bgp`)
  await inSight(page, "main", "State")
})

test.describe("at desktop width", () => {
  test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false })
  test("the hidden columns come back", async ({ page }) => {
    await page.goto(`/routers/${routerId()}/interfaces`)
    for (const h of ["Addresses", "MTU", "Received", "Sent", "Errors / drops"]) await expect(page.locator("th", { hasText: new RegExp(`^${h}$`) })).toBeVisible()
  })
})
