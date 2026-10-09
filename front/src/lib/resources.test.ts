import assert from "node:assert/strict"
import { test } from "node:test"

import { cpuMap, cpuPlanes, isResourceView, layoutCpus, memorySplit, parseCpus, showCpus } from "./resources.ts"

test("a CPU layout reads by plane (#81)", () => {
  assert.deepEqual(parseCpus("0-1"), [0, 1])
  assert.deepEqual(parseCpus("3-7"), [3, 4, 5, 6, 7])
  assert.deepEqual(parseCpus("0-1, 4,6-7"), [0, 1, 4, 6, 7])
  assert.deepEqual(parseCpus(""), [])
  assert.deepEqual(parseCpus("all"), [], "text that is not a list is not guessed")
  // As 192.0.2.166 reports it.
  const p = cpuPlanes({ control_plane_cpus: "0-1", main_thread_cpu: "2", worker_cpus: "3-7" })
  assert.deepEqual(p.map((x) => x.cpus.length), [2, 1, 5])
  assert.equal(layoutCpus(p).length, 8)
  assert.equal(showCpus([0, 1, 4, 6, 7]), "0-1, 4, 6-7")
})

test("the RAM splits by plane", () => {
  // 192.0.2.166: 15.6 GiB, 6 GiB of hugepages, 6.8 GiB used.
  const m = memorySplit({ memory_total_bytes: 16772935680, memory_used_bytes: 7262539776, memory_hugepages_bytes: 6442450944 })
  assert.ok(m)
  assert.equal(m.dataplane, 6442450944)
  assert.equal(m.control, 7262539776 - 6442450944)
  assert.equal(m.free, 16772935680 - 7262539776)
  assert.equal(memorySplit({ memory_total_bytes: 0 }), null)
})

test("the CPU map has a tile per CPU, its plane and a worker's load (#85)", () => {
  const p = cpuPlanes({ control_plane_cpus: "0-1", main_thread_cpu: "2", worker_cpus: "4-5" })
  const m = cpuMap(p, [{ cpu: 4, busy_ratio: 0.25 }, { cpu: 5, busy_ratio: 0.9 }], 0.5)
  assert.deepEqual(m.map((t) => t.plane), ["control", "control", "main", null, "workers", "workers"], "CPU 3 is in no plane")
  assert.deepEqual(m.map((t) => t.load), [null, null, null, null, 0.5, 1], "load over saturation, capped at 1")
  assert.deepEqual(cpuMap(cpuPlanes({}), [], 0.5), [])
  assert.ok(isResourceView("map") && !isResourceView("pie"))
})
