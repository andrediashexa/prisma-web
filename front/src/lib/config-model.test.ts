// Run with `npm test` (node:test, types stripped; no dependency).
import assert from "node:assert/strict"
import { test } from "node:test"

import { invalidParam } from "./config-model.ts"

test("an address list checks each address (#72)", () => {
  const list = { kind: { k: "address" } as const, rest: true }
  assert.equal(invalidParam(list, "192.0.2.166 2001:db8:6::166"), null)
  assert.equal(invalidParam(list, "192.0.2.166"), null)
  assert.equal(invalidParam(list, "192.0.2.166 nope"), "an IPv4 or IPv6 address")
  // One address stays one.
  assert.equal(invalidParam({ kind: { k: "address" }, rest: false }, "192.0.2.166 2001:db8:6::166"), "an IPv4 or IPv6 address")
  // Text is any words.
  assert.equal(invalidParam({ kind: { k: "text" }, rest: true }, "uplink to core"), null)
})

test("a bracketed IPv6 address is an address, as sshd prints it (#83)", () => {
  const list = { kind: { k: "address" } as const, rest: true }
  assert.equal(invalidParam(list, "0.0.0.0 [::]"), null)
  assert.equal(invalidParam(list, "192.0.2.166 [2001:db8:6::166]"), null)
  assert.equal(invalidParam(list, "[nope]"), "an IPv4 or IPv6 address")
  assert.equal(invalidParam(list, "[10.0.0.1]"), "an IPv4 or IPv6 address", "brackets are IPv6's")
})
