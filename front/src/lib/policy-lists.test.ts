import assert from "node:assert/strict"
import { test } from "node:test"

import { communityLists, isListName, isPrefix, memberError, removeList, setMembers, usedBy } from "./policy-lists.ts"

const policies = [
  {
    name: "TRANSIT-IN",
    text: "policy-statement TRANSIT-IN\n term bogons\n  from prefix-list BOGONS\n  then reject\n term cust\n  from community CUSTOMERS\n  then local-preference 200\n",
  },
  { name: "TAG", text: "policy-statement TAG\n term t\n  set community add CUSTOMERS\n  set large-community set BIG\n" },
  { name: "OWN", text: "policy-statement OWN\n term own\n  from prefix-list OWN-PREFIXES\n" },
]

test("a list is used by the policies whose terms name it, in a from or a set", () => {
  assert.deepEqual(usedBy(policies, "prefix-list", "BOGONS"), ["TRANSIT-IN"])
  assert.deepEqual(usedBy(policies, "community", "CUSTOMERS"), ["TRANSIT-IN", "TAG"])
  assert.deepEqual(usedBy(policies, "large-community", "BIG"), ["TAG"])
  assert.deepEqual(usedBy(policies, "community", "BOGONS"), [])
  assert.deepEqual(usedBy(policies, "prefix-list", "OWN"), [])
})

test("members are checked by kind", () => {
  assert.ok(isPrefix("10.0.0.0/8") && isPrefix("2001:db8::/32") && isPrefix("::/0"))
  assert.ok(!isPrefix("10.0.0.0") && !isPrefix("10.0.0.0/33") && !isPrefix("2001:db8::/129") && !isPrefix("300.0.0.0/8"))
  assert.equal(memberError("prefix-list", "198.51.100.0/24"), null)
  assert.match(memberError("prefix-list", "nope") ?? "", /network/)
  assert.equal(memberError("community", "65000:100"), null)
  assert.notEqual(memberError("community", "65536:1"), null)
  assert.notEqual(memberError("community", "65000:1:2"), null)
  assert.equal(memberError("large-community", "4200000000:1:100"), null)
  assert.notEqual(memberError("large-community", "65000:1"), null)
  assert.equal(memberError("extended-community", "rt:65000:100"), null)
  assert.equal(memberError("extended-community", "soo:192.0.2.1:7"), null)
  assert.notEqual(memberError("extended-community", "65000:100"), null)
  assert.ok(isListName("OWN-PREFIXES") && !isListName("two words") && !isListName(""))
})

test("a prefix-list's members are lines in its mode; a community is written whole", () => {
  assert.deepEqual(setMembers("prefix-list", "P", ["10.0.0.0/8", "172.16.0.0/12"], ["10.0.0.0/8", "192.0.2.0/24"]), {
    path: ["policy-options", "prefix-list P"],
    lines: ["no 172.16.0.0/12", "192.0.2.0/24"],
  })
  assert.deepEqual(setMembers("prefix-list", "N", null, ["192.0.2.0/24"]), { path: ["policy-options", "prefix-list N"], lines: ["192.0.2.0/24"] })
  assert.deepEqual(setMembers("prefix-list", "P", ["10.0.0.0/8"], []), { path: ["policy-options"], lines: ["no prefix-list P"] })
  assert.deepEqual(setMembers("community", "C", ["65000:1"], ["65000:1", "65000:2"]), {
    path: ["policy-options"],
    lines: ["no community C", "community C members 65000:1 65000:2"],
  })
  assert.deepEqual(setMembers("community", "C", null, ["65000:1"]), { path: ["policy-options"], lines: ["community C members 65000:1"] })
  assert.deepEqual(setMembers("large-community", "L", ["65000:1:1"], []), { path: ["policy-options"], lines: ["no large-community L"] })
  assert.deepEqual(removeList("extended-community", "E"), { path: ["policy-options"], lines: ["no extended-community E"] })
})

test("FRR's community lists are the community and large-community ones", () => {
  const f = {
    prefix_lists: [],
    bgp_lists: [
      { kind: "community", style: "standard", name: "A", entries: [] },
      { kind: "as-path", style: "", name: "B", entries: [] },
      { kind: "large-community", style: "expanded", name: "C", entries: [] },
    ],
  }
  assert.deepEqual(communityLists(f).map((b) => b.name), ["A", "C"])
})
