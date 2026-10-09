import assert from "node:assert/strict"
import { test } from "node:test"

import { buckets, cpusOf, historyRows, loadOf } from "./cpu-usage.ts"

test("a polling CPU's load is its busy_ratio over saturation, any other's its busy percent (#87)", () => {
  assert.equal(loadOf({ polling: true, busy_percent: 99.8, busy_ratio: 0.25 }, 0.5), 0.5)
  assert.equal(loadOf({ polling: false, busy_percent: 15, busy_ratio: 0 }, 0.5), 0.15)
  assert.equal(loadOf({ polling: true, busy_percent: 100, busy_ratio: 0.7 }, 0.5), 1, "capped")
})

test("the history reads every CPU, or the workers on a box before 0.152.9, and buckets for a heatmap", () => {
  const rows = historyRows(
    [
      { at: "2026-10-09T10:01:00Z", cpus: [{ cpu: 0, busy_percent: 20, steal_percent: 0, polling: false, busy_ratio: 0, window_ms: 60000 }, { cpu: 3, busy_percent: 100, steal_percent: 0, polling: true, busy_ratio: 0.1, window_ms: 60000 }] },
      { at: "2026-10-09T10:00:00Z", cpus: [], workers: [{ worker: 0, cpu: 3, busy_ratio: 0.3 }] },
    ],
    0.5,
  )
  assert.deepEqual(rows.map((r) => r.loads), [{ 3: 0.6 }, { 0: 0.2, 3: 0.2 }], "sorted by time; the old sample by its workers")
  assert.deepEqual(cpusOf(rows), [0, 3])
  const b = buckets(rows, 1)
  assert.equal(b.length, 1)
  assert.equal(b[0].loads[0], 0.2)
  assert.ok(Math.abs((b[0].loads[3] ?? 0) - 0.4) < 1e-9, "averaged in the bucket")
})
