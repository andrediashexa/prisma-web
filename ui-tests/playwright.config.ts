import { defineConfig } from "@playwright/test"

// Browser tests of prisma-web against the compose stack with the mocks (#5).
// Run with scripts/ui-tests.sh; see CONTRIBUTING.md, section 7.
export default defineConfig({
  testDir: "./tests",
  // The tests share one simulated Prisma: one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  globalSetup: "./setup.ts",
  globalTeardown: "./teardown.ts",
  use: {
    baseURL: process.env.UI_BASE ?? "http://127.0.0.1",
    storageState: ".state/session.json",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
})
