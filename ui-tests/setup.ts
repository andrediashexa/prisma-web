import { mkdirSync, writeFileSync } from "node:fs"

import { request } from "@playwright/test"

/** Signs in, saves the session and registers a router of its own on the plain mock. */
export default async function setup() {
  const user = process.env.E2E_USER
  const password = process.env.E2E_PASSWORD
  if (!user || !password) throw new Error("set E2E_USER and E2E_PASSWORD (an administrator)")
  const api = await request.newContext({ baseURL: process.env.UI_BASE ?? "http://127.0.0.1" })
  const login = await api.post("/api/auth/login", { data: { username: user, password } })
  if (!login.ok()) throw new Error(`login failed: ${login.status()}`)
  const r = await api.post("/api/routers", {
    data: { name: `ui-${Date.now().toString(36)}`, api_url: process.env.UI_MOCK_URL ?? "http://prisma-mock:50051" },
  })
  if (!r.ok()) throw new Error(`router registration failed: ${r.status()} ${await r.text()}`)
  mkdirSync(".state", { recursive: true })
  await api.storageState({ path: ".state/session.json" })
  writeFileSync(".state/router.json", JSON.stringify({ id: (await r.json()).id }))
  await api.dispose()
}
