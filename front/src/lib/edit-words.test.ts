import assert from "node:assert/strict"
import { test } from "node:test"

import { editWordsOffered, renameError, renameLine, replaceError, replaceLine } from "./edit-words.ts"

test("replace and rename are offered from Prisma 0.151.13 (#74)", () => {
  assert.equal(editWordsOffered("0.151.13"), true)
  assert.equal(editWordsOffered("0.151.13-mock"), true)
  assert.equal(editWordsOffered("0.152.0"), true)
  assert.equal(editWordsOffered("0.151.12"), false)
  assert.equal(editWordsOffered("0.149.0-mock"), false)
  assert.equal(editWordsOffered(undefined), false)
})

test("the replace line quotes its values and takes the preview", () => {
  const f = { pattern: 'block-size 512|"x"', replacement: "block-size 1024", upto: "" }
  assert.equal(replaceLine(f, true), 'replace pattern "block-size 512|\\"x\\"" with "block-size 1024" | compare')
  assert.equal(replaceLine({ ...f, upto: "2" }, false), 'replace pattern "block-size 512|\\"x\\"" with "block-size 1024" upto 2')
  assert.equal(replaceError({ ...f, pattern: "" }), "a pattern")
  assert.equal(replaceError({ ...f, upto: "0" }), "upto: a number of substitutions, 1 or more")
  assert.equal(replaceError(f), null)
})

test("the rename line names what it renames", () => {
  assert.equal(renameLine({ kind: "ip-prefix-list", name: "SUBS", to: "CUSTOMERS", asn: "" }), "rename ip prefix-list SUBS to CUSTOMERS")
  assert.equal(renameLine({ kind: "peer-group", name: "UP", to: "UPSTREAM", asn: "65000" }), "rename router bgp 65000 peer-group UP to UPSTREAM")
  assert.equal(renameError({ kind: "peer-group", name: "UP", to: "UPSTREAM", asn: "" }), "the BGP instance's AS")
  assert.equal(renameError({ kind: "cgnat-pool", name: "A", to: "A", asn: "" }), "a different name")
})
