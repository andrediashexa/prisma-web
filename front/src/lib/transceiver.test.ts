import assert from "node:assert/strict"
import { test } from "node:test"

import { showLevel, showThresholds, toneOf, type TransceiverLevel } from "./transceiver.ts"

const lv = (o: Partial<TransceiverLevel>): TransceiverLevel => ({
  known: true, value: 0, thresholds_known: true, high_alarm: 1, low_alarm: 0.0158, high_warning: 0.794, low_warning: 0.0316, level: "NORMAL", ...o,
})

test("a transceiver's level reads known and thresholds_known first (#76)", () => {
  assert.equal(showLevel(lv({ no_light: true, level: "LOW_ALARM" }), "power"), "no light")
  assert.equal(toneOf(lv({ no_light: true, level: "LOW_ALARM" })), "alarm")
  assert.equal(showLevel(lv({ value: 0.48, dbm: -3.188 }), "power"), "-3.19 dBm (0.480 mW)")
  assert.equal(showLevel(lv({ known: false }), "power"), "not measured")
  // No thresholds: unknown, never an alarm, whatever level the zeros would give.
  assert.equal(toneOf(lv({ thresholds_known: false, level: "LOW_ALARM" })), "unknown")
  assert.equal(showThresholds(lv({ thresholds_known: false }), "power"), "The module carries no thresholds for it.")
  assert.equal(toneOf(lv({ level: "LOW_WARNING" })), "warning")
  assert.equal(showLevel(lv({ value: 3.312 }), "V"), "3.31 V")
})
