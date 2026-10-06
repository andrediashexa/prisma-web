import assert from "node:assert/strict"
import { test } from "node:test"

import { causeText, restartNote } from "./start-cause.ts"

test("only an unexpected start is a dataplane that restarted by itself (#75)", () => {
  assert.equal(restartNote({ dataplane_restarted: false, dataplane_start_cause: "unexpected" }), null)
  assert.equal(restartNote({ dataplane_restarted: true, dataplane_start_cause: "unexpected" })?.tone, "destructive")
  assert.equal(restartNote({ dataplane_restarted: true, dataplane_start_cause: "operator" })?.short, "dataplane restarted on request")
  assert.equal(restartNote({ dataplane_restarted: true, dataplane_start_cause: "upgrade" })?.tone, "info")
  // "" is not recorded, never "by itself".
  const none = restartNote({ dataplane_restarted: true, dataplane_start_cause: "" })
  assert.equal(none?.tone, "warning")
  assert.ok(!none?.long.includes("by itself"))
  assert.equal(causeText(""), "cause not recorded")
  assert.equal(causeText(undefined), null)
})
