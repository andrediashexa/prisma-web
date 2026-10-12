import assert from "node:assert/strict"
import { test } from "node:test"

import { peerPathError, releaseAtLeast, vrFamily, vrKey } from "./release.ts"

test("a release is compared part by part; an unknown one is not recent", () => {
  assert.ok(releaseAtLeast("0.152.11", [0, 152, 11]))
  assert.ok(releaseAtLeast("v0.152.11-mock", [0, 152, 11]))
  assert.ok(releaseAtLeast("0.153.0", [0, 152, 11]))
  assert.ok(!releaseAtLeast("0.152.9", [0, 152, 11]))
  assert.ok(!releaseAtLeast("0.149.26-mock", [0, 152, 11]))
  assert.ok(!releaseAtLeast(undefined, [0, 0, 1]))
})

test("a peer copy's path is empty or absolute", () => {
  assert.equal(peerPathError(""), null)
  assert.equal(peerPathError("/var/lib/prisma-routing/ha-peer.conf"), null)
  assert.match(peerPathError("ha-peer.conf") ?? "", /absolute/)
  assert.match(peerPathError("/" + "a".repeat(4096)) ?? "", /4096/)
})

test("a virtual router is keyed by its family too, and an old box's 0 is IPv4", () => {
  assert.equal(vrFamily(0), 4)
  assert.equal(vrFamily(undefined), 4)
  assert.equal(vrFamily(6), 6)
  const v4 = { interface: "lan0", vr_id: 10, family: 4 }
  const v6 = { interface: "lan0", vr_id: 10, family: 6 }
  assert.notEqual(vrKey(v4), vrKey(v6))
  assert.equal(vrKey({ interface: "lan0", vr_id: 10, family: 0 }), vrKey(v4))
})
