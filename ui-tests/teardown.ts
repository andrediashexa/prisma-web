import { readFileSync } from "node:fs"

import { request } from "@playwright/test"

/** Removes the routers the suite registered and its home page changes. */
export default async function teardown() {
  const api = await request.newContext({
    baseURL: process.env.UI_BASE ?? "http://127.0.0.1",
    storageState: ".state/session.json",
  })
  const { id, lines } = JSON.parse(readFileSync(".state/router.json", "utf8"))
  await api.delete(`/api/routers/${id}`)
  if (lines) await api.delete(`/api/routers/${lines}`)
  await api.delete("/api/dashboard")
  await api.dispose()
}
