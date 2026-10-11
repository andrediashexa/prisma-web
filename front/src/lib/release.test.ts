import assert from "node:assert/strict"
import { test } from "node:test"

import { peerPathError, releaseAtLeast } from "./release.ts"

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
