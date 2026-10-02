import { readFileSync } from "node:fs"

import { request } from "@playwright/test"

/** Removes the router the suite registered and its home page changes. */
export default async function teardown() {
  const api = await request.newContext({
    baseURL: process.env.UI_BASE ?? "http://127.0.0.1",
    storageState: ".state/session.json",
  })
  const { id } = JSON.parse(readFileSync(".state/router.json", "utf8"))
  await api.delete(`/api/routers/${id}`)
  await api.delete("/api/dashboard")
  await api.dispose()
}
