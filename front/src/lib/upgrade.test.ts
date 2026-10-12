import assert from "node:assert/strict"
import { test } from "node:test"

import { downloadPercent, downloadText, foldUpgrade, isDownloadProgress } from "./upgrade.ts"

type P = { phase: "STARTED" | "DOWNLOAD" | "VERIFY"; message?: string; downloaded_bytes?: number; total_bytes?: number }

test("the download's progress is one row, the latest, and its other lines stay", () => {
  const stream: P[] = [
    { phase: "STARTED" },
    { phase: "DOWNLOAD", message: "https://example.net/prisma.deb" },
    { phase: "DOWNLOAD", downloaded_bytes: 5_000_000, total_bytes: 189_000_000 },
    { phase: "DOWNLOAD", message: "nothing arrived for 30 s" },
    { phase: "DOWNLOAD", downloaded_bytes: 14_100_000, total_bytes: 189_000_000 },
    { phase: "DOWNLOAD", downloaded_bytes: 189_000_000, total_bytes: 189_000_000 },
    { phase: "VERIFY", message: "sha256 ok" },
  ]
  const rows = stream.reduce<P[]>(foldUpgrade, [])
  assert.deepEqual(
    rows.map((r) => r.message ?? r.downloaded_bytes),
    [undefined, "https://example.net/prisma.deb", "nothing arrived for 30 s", 189_000_000, "sha256 ok"],
  )
  assert.equal(rows.filter(isDownloadProgress).length, 1)
})

test("an older box's single DOWNLOAD is a row like any other", () => {
  const rows = [{ phase: "DOWNLOAD" as const, message: "prisma.deb" }].reduce<P[]>(foldUpgrade, [])
  assert.equal(rows.length, 1)
  assert.ok(!isDownloadProgress(rows[0]))
})

test("the numbers read as the box's line, and what it could not tell is left out", () => {
  assert.equal(downloadText({ downloaded_bytes: 14_100_000, total_bytes: 189_000_000, bytes_per_second: 2_300_000, seconds_left: 76 }), "14.1 of 189.0 MB, 2.3 MB/s, 1 min 16 s left")
  assert.equal(downloadText({ downloaded_bytes: 14_100_000, total_bytes: 0, bytes_per_second: 52_000, seconds_left: 0 }), "14.1 MB, 52 KB/s")
  assert.equal(downloadText({ downloaded_bytes: 1_000_000, total_bytes: 2_000_000, seconds_left: 120 }), "1.0 of 2.0 MB, 2 min left")
  assert.equal(downloadPercent({ downloaded_bytes: 14_100_000, total_bytes: 189_000_000 }), 7)
  assert.equal(downloadPercent({ downloaded_bytes: 14_100_000, total_bytes: 0 }), null)
})
