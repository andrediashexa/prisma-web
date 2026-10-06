/**
 * A transceiver's levels (Prisma 0.151.15, #76), read the way the box asks: `known` before the
 * value and `thresholds_known` before the four thresholds (0 is not absent), and a power of 0 mW
 * as "no light", which has no dBm.
 */
export interface TransceiverLevel {
  known: boolean
  value: number
  thresholds_known: boolean
  high_alarm: number
  low_alarm: number
  high_warning: number
  low_warning: number
  /** NORMAL, HIGH_WARNING, LOW_WARNING, HIGH_ALARM, LOW_ALARM or UNKNOWN. */
  level: string
  no_light?: boolean
  dbm?: number
  high_alarm_dbm?: number
  low_alarm_dbm?: number
  high_warning_dbm?: number
  low_warning_dbm?: number
}

export type Tone = "ok" | "warning" | "alarm" | "unknown"

export function toneOf(l: TransceiverLevel | null | undefined): Tone {
  if (!l?.known || !l.thresholds_known) return "unknown"
  if (l.level.endsWith("ALARM")) return "alarm"
  if (l.level.endsWith("WARNING")) return "warning"
  return l.level === "NORMAL" ? "ok" : "unknown"
}

const n = (v: number, d: number) => v.toFixed(d)

/** The value as shown: a power in dBm with its mW, "no light" for 0 mW, "not measured" when unknown. */
export function showLevel(l: TransceiverLevel | null | undefined, unit: "°C" | "V" | "mA" | "power"): string {
  if (!l || !l.known) return "not measured"
  if (unit === "power") return l.no_light ? "no light" : `${n(l.dbm ?? 0, 2)} dBm (${n(l.value, 3)} mW)`
  return `${n(l.value, unit === "V" ? 2 : 1)} ${unit}`
}

/** The thresholds as a title: warnings and alarms, or why there are none. */
export function showThresholds(l: TransceiverLevel | null | undefined, unit: "°C" | "V" | "mA" | "power"): string {
  if (!l || !l.known) return "The module gives no value for it."
  if (!l.thresholds_known) return "The module carries no thresholds for it."
  const v = (x: number, dbm?: number) => (unit === "power" ? (x === 0 ? "no light" : `${n(dbm ?? 0, 2)} dBm`) : `${n(x, unit === "V" ? 2 : 1)} ${unit}`)
  return `warning below ${v(l.low_warning, l.low_warning_dbm)} or above ${v(l.high_warning, l.high_warning_dbm)}; alarm below ${v(l.low_alarm, l.low_alarm_dbm)} or above ${v(l.high_alarm, l.high_alarm_dbm)}`
}
