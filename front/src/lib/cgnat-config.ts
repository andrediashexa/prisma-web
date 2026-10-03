/**
 * The CGNAT configuration for the CGNAT forms (#41): read from the running
 * configuration as a tree (#39) and written as VTY lines under `nat > cgnat`.
 *
 * This is the only place that knows those lines. When the box answers the
 * typed GetConfig and SetPool/SetLogging (Prisma 0.149.20), readCgnat() and
 * the *Changes() functions are what switch to them; the forms keep the shapes
 * below.
 */

import type { ConfigChange } from "@/hooks/use-config-changes"
import { invalid, type Instance, type Kind } from "@/lib/config-model"

export const CGNAT_PATH = ["nat", "cgnat"]
export const poolPath = (name: string) => [...CGNAT_PATH, `pool ${name}`]
/** The Settings key of a pool, for the link to its other statements. */
export const poolKey = (name: string) => poolPath(name).join(" > ")

const INT32: Kind = { k: "int", min: 1, max: 4294967295 }

export const GLOBAL_TIMEOUTS = ["udp", "icmp", "tcp-transitory", "tcp-established"] as const
export type GlobalTimeout = (typeof GLOBAL_TIMEOUTS)[number]

export type Side = "inside" | "outside"
export type IdentityKind = "" | "none" | "file" | "dhcp-leases" | "radius"

/** `nat > cgnat` itself. An empty string is a statement not set. */
export interface CgnatGlobal {
  timeouts: Record<GlobalTimeout, string>
  blockHolddown: string
  interfaces: { name: string; side: Side }[]
  identity: { kind: IdentityKind; path: string; secret: string; port: string }
  sessionTable: { buckets: string; memory: string }
  memory: string
}

export type LogKind = "syslog" | "tcp" | "udp"
export const LOG_KINDS: LogKind[] = ["syslog", "tcp", "udp"]

/** One `logging <kind>` statement: a collector, `disable`, or not set at all. */
export interface LogTarget {
  state: "" | "collector" | "disabled"
  collector: string
  /** udp, tcp. */
  port: string
  /** udp: `src`. */
  source: string
  /** syslog: `enterprise`. */
  enterprise: string
  /** syslog: the rest of the line. */
  options: string
}

export interface CgnatLogging {
  /** `logging enable|disable`: the whole export. */
  export: "" | "enable" | "disable"
  targets: Record<LogKind, LogTarget>
}

/** Pool statements with one value, the form's fields. */
export const POOL_SCALARS = [
  "block-size",
  "mode",
  "policy",
  "max-blocks",
  "ports",
  "initial-allocation",
  "utilisation-alarm",
  "max-sessions",
  "max-session-rate",
  "filter",
  "tcp-mss",
] as const
export type PoolScalar = (typeof POOL_SCALARS)[number]
export const ALGS = ["ftp", "rtsp", "pptp", "esp", "sip"] as const
export type Alg = (typeof ALGS)[number]

export interface PoolConfig {
  name: string
  inside: string[]
  outside: string[]
  /** The value after the keyword (`ports` is "low high", `tcp-mss` is "auto"). */
  scalars: Record<PoolScalar, string>
  algs: Record<Alg, "" | "on" | "off">
  /** Lines the form does not cover (timeouts, bypasses, forwards, VRFs): edited in Settings. */
  other: string[]
}

export interface CgnatConfig {
  global: CgnatGlobal
  logging: CgnatLogging
  pools: PoolConfig[]
  /** `nat > cgnat` lines no form here covers. */
  other: string[]
}

const words = (l: string) => l.trim().split(/\s+/)
const after = (w: string[], key: string) => {
  const i = w.indexOf(key)
  return i >= 0 && i + 1 < w.length ? w[i + 1] : ""
}

export const emptyTarget = (): LogTarget => ({ state: "", collector: "", port: "", source: "", enterprise: "", options: "" })

export function emptyPool(name = ""): PoolConfig {
  return {
    name,
    inside: [],
    outside: [],
    scalars: Object.fromEntries(POOL_SCALARS.map((k) => [k, ""])) as Record<PoolScalar, string>,
    algs: Object.fromEntries(ALGS.map((a) => [a, ""])) as Record<Alg, "" | "on" | "off">,
    other: [],
  }
}

function readPool(name: string, lines: string[]): PoolConfig {
  const p = emptyPool(name)
  for (const l of lines) {
    const w = words(l)
    if (w[0] === "prefix-inside" && w[1]) p.inside.push(w[1])
    else if (w[0] === "prefix-outside" && w[1]) p.outside.push(w[1])
    else if (w[0] === "alg" && (ALGS as readonly string[]).includes(w[1]) && (w[2] === "on" || w[2] === "off")) p.algs[w[1] as Alg] = w[2]
    else if ((POOL_SCALARS as readonly string[]).includes(w[0]) && w.length > 1) p.scalars[w[0] as PoolScalar] = w.slice(1).join(" ")
    else p.other.push(l.trim())
  }
  return p
}

/** The CGNAT configuration out of the tree's instances. */
export function readCgnat(instances: Instance[]): CgnatConfig {
  const global: CgnatGlobal = {
    timeouts: { udp: "", icmp: "", "tcp-transitory": "", "tcp-established": "" },
    blockHolddown: "",
    interfaces: [],
    identity: { kind: "", path: "", secret: "", port: "" },
    sessionTable: { buckets: "", memory: "" },
    memory: "",
  }
  const logging: CgnatLogging = { export: "", targets: { syslog: emptyTarget(), tcp: emptyTarget(), udp: emptyTarget() } }
  const other: string[] = []
  const cgnat = instances.find((i) => i.path.join(" > ") === CGNAT_PATH.join(" > "))
  for (const line of cgnat?.lines ?? []) {
    const l = line.text.trim()
    const w = words(l)
    if (w[0] === "timeout" && (GLOBAL_TIMEOUTS as readonly string[]).includes(w[1]) && w[2]) global.timeouts[w[1] as GlobalTimeout] = w[2]
    else if (w[0] === "block-holddown" && w[1]) global.blockHolddown = w[1]
    else if (w[0] === "interface" && w[1] && (w[2] === "inside" || w[2] === "outside")) global.interfaces.push({ name: w[1], side: w[2] })
    else if (w[0] === "identity" && w[1]) {
      const kind = w[1] as IdentityKind
      global.identity = {
        kind,
        path: kind === "file" || kind === "dhcp-leases" ? w.slice(2).join(" ") : "",
        secret: kind === "radius" ? after(w, "secret") : "",
        port: kind === "radius" ? after(w, "port") : "",
      }
    } else if (w[0] === "session-table") global.sessionTable = { buckets: after(w, "buckets"), memory: after(w, "memory") }
    else if (w[0] === "memory" && w[1]) global.memory = w[1]
    else if (w[0] === "logging" && (w[1] === "enable" || w[1] === "disable") && w.length === 2) logging.export = w[1]
    else if (w[0] === "logging" && (LOG_KINDS as string[]).includes(w[1]) && w[2]) {
      const t = emptyTarget()
      if (w[2] === "disable") t.state = "disabled"
      else {
        t.state = "collector"
        t.collector = w[2]
        if (w[1] === "syslog") {
          t.enterprise = after(w, "enterprise")
          const e = w.indexOf("enterprise")
          t.options = e >= 0 ? w.slice(e + 2).join(" ") : ""
        } else {
          t.port = after(w, "port")
          t.source = w[1] === "udp" ? after(w, "src") : ""
        }
      }
      logging.targets[w[1] as LogKind] = t
    } else other.push(l)
  }
  const pools = instances
    .filter((i) => i.path.length === 3 && i.path[0] === "nat" && i.path[1] === "cgnat" && i.path[2].startsWith("pool "))
    .map((i) => readPool(i.path[2].slice("pool ".length).trim(), i.lines.map((l) => l.text)))
  return { global, logging, pools, other }
}

// --- validation -----------------------------------------------------------

/** Why a value does not fit, or null; an empty value is fine unless required. */
export function check(kind: Kind, v: string, required = false): string | null {
  if (!v.trim()) return required ? "required" : null
  return invalid(kind, v.trim())
}

export const int = (min: number, max: number): Kind => ({ k: "int", min, max })

const noSpaces = (v: string) => (/\s/.test(v.trim()) ? "a single word, no spaces" : null)

/** Problems of the global form, by field. */
export function globalErrors(before: CgnatGlobal, g: CgnatGlobal): Record<string, string> {
  const e: Record<string, string | null> = {}
  for (const t of GLOBAL_TIMEOUTS) e[`timeout ${t}`] = check(INT32, g.timeouts[t], !!before.timeouts[t])
  e["block-holddown"] = check(INT32, g.blockHolddown, !!before.blockHolddown)
  e.memory = check(int(0, 4294967295), g.memory, !!before.memory)
  const st = g.sessionTable
  const anyTable = !!(st.buckets || st.memory || before.sessionTable.buckets)
  e["session-table buckets"] = check(int(0, 4294967295), st.buckets, anyTable)
  e["session-table memory"] = check(int(0, 4294967295), st.memory, anyTable)
  const id = g.identity
  if (id.kind === "file" || id.kind === "dhcp-leases") e["identity path"] = id.path.trim() ? noSpaces(id.path) : "required"
  if (id.kind === "radius") {
    e["identity secret"] = id.secret.trim() ? noSpaces(id.secret) : "required"
    e["identity port"] = check(int(1, 65535), id.port)
  }
  const names = g.interfaces.map((i) => i.name)
  g.interfaces.forEach((i, n) => {
    e[`interface ${n}`] = !i.name.trim() ? "pick an interface" : names.indexOf(i.name) !== n ? "listed twice" : noSpaces(i.name)
  })
  return Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as Record<string, string>
}

export function loggingErrors(l: CgnatLogging): Record<string, string> {
  const e: Record<string, string | null> = {}
  for (const k of LOG_KINDS) {
    const t = l.targets[k]
    if (t.state !== "collector") continue
    e[`${k} collector`] = check({ k: "address" }, t.collector, true)
    if (k === "udp") e[`${k} source`] = check({ k: "address" }, t.source, true)
    if (k !== "syslog") e[`${k} port`] = check(int(1, 65535), t.port)
    if (k === "syslog") e[`${k} enterprise`] = check(int(0, 4294967295), t.enterprise, true)
  }
  return Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as Record<string, string>
}

const SCALAR_KIND: Partial<Record<PoolScalar, Kind>> = {
  "block-size": int(64, 32768),
  "max-blocks": int(1, 255),
  "initial-allocation": int(1, 65535),
  "utilisation-alarm": int(1, 100),
  "max-sessions": int(0, 4294967295),
  "max-session-rate": int(0, 4294967295),
}

/** Statements the VTY has no `no` form for: once set, they can only be changed. */
const NO_UNSET: PoolScalar[] = ["block-size", "mode", "policy"]

export function poolErrors(before: PoolConfig | null, p: PoolConfig, taken: string[]): Record<string, string> {
  const e: Record<string, string | null> = {}
  if (!before) {
    e.name = !p.name.trim() ? "required" : noSpaces(p.name) ?? (taken.includes(p.name.trim()) ? "a pool with this name exists" : null)
  }
  p.inside.forEach((x, n) => (e[`inside ${n}`] = check({ k: "ipv4_prefix" }, x, true)))
  p.outside.forEach((x, n) => (e[`outside ${n}`] = check({ k: "ipv4_prefix" }, x, true)))
  if (!before && p.inside.length === 0) e.inside = "at least one inside prefix"
  if (!before && p.outside.length === 0) e.outside = "at least one outside prefix"
  for (const [k, kind] of Object.entries(SCALAR_KIND) as [PoolScalar, Kind][]) {
    e[k] = check(kind, p.scalars[k], !!before?.scalars[k] && NO_UNSET.includes(k))
  }
  const ports = p.scalars.ports.trim()
  if (ports) {
    const [lo, hi, extra] = ports.split(/\s+/)
    e.ports =
      extra !== undefined || check(int(1, 65535), lo ?? "", true) || check(int(1, 65535), hi ?? "", true)
        ? "two ports, low and high (1-65535)"
        : Number(lo) > Number(hi)
          ? "the low port must not be above the high one"
          : null
  }
  return Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as Record<string, string>
}

// --- writing ------------------------------------------------------------------

/** The lines that take `nat > cgnat` from `a` to `b`. */
export function globalChanges(a: CgnatGlobal, b: CgnatGlobal): ConfigChange[] {
  const lines: string[] = []
  // These have no `no` form in the VTY: a new value replaces the old one.
  for (const t of GLOBAL_TIMEOUTS) if (b.timeouts[t].trim() && b.timeouts[t].trim() !== a.timeouts[t]) lines.push(`timeout ${t} ${b.timeouts[t].trim()}`)
  if (b.blockHolddown.trim() && b.blockHolddown.trim() !== a.blockHolddown) lines.push(`block-holddown ${b.blockHolddown.trim()}`)
  for (const i of a.interfaces) if (!b.interfaces.some((x) => x.name === i.name)) lines.push(`no interface ${i.name}`)
  for (const i of b.interfaces) {
    const was = a.interfaces.find((x) => x.name === i.name)
    if (!was || was.side !== i.side) lines.push(`interface ${i.name.trim()} ${i.side}`)
  }
  const id = identityLine(b.identity)
  if (id && id !== identityLine(a.identity)) lines.push(id)
  const st = b.sessionTable
  if (st.buckets.trim() && st.memory.trim() && (st.buckets.trim() !== a.sessionTable.buckets || st.memory.trim() !== a.sessionTable.memory)) {
    lines.push(`session-table buckets ${st.buckets.trim()} memory ${st.memory.trim()}`)
  }
  if (b.memory.trim() && b.memory.trim() !== a.memory) lines.push(`memory ${b.memory.trim()}`)
  return lines.length ? [{ path: CGNAT_PATH, lines, label: "CGNAT settings" }] : []
}

function identityLine(i: CgnatGlobal["identity"]): string {
  switch (i.kind) {
    case "":
      return ""
    case "none":
      return "identity none"
    case "file":
    case "dhcp-leases":
      return `identity ${i.kind} ${i.path.trim()}`
    case "radius":
      return `identity radius secret ${i.secret.trim()}${i.port.trim() ? ` port ${i.port.trim()}` : ""}`
  }
}

export function targetLine(kind: LogKind, t: LogTarget): string {
  if (t.state === "disabled") return `logging ${kind} disable`
  if (t.state !== "collector") return ""
  const c = t.collector.trim()
  if (kind === "syslog") return `logging syslog ${c} enterprise ${t.enterprise.trim()}${t.options.trim() ? ` ${t.options.trim()}` : ""}`
  const port = t.port.trim() ? ` port ${t.port.trim()}` : ""
  return kind === "udp" ? `logging udp ${c} src ${t.source.trim()}${port}` : `logging tcp ${c}${port}`
}

/**
 * Disabling a syslog the running configuration never enabled: before Prisma
 * 0.149.8 that stops the dataplane, and the back refuses to commit it (#31).
 */
export function disablesNeverEnabledSyslog(a: CgnatLogging, b: CgnatLogging) {
  return b.targets.syslog.state === "disabled" && a.targets.syslog.state === ""
}

export const SYSLOG_DISABLE_WARNING =
  "Syslog was never enabled on this router. Before Prisma 0.149.8, `logging syslog disable` then stops the dataplane until the box is rebooted, so prisma-web refuses to commit it on those releases."

export function loggingChanges(a: CgnatLogging, b: CgnatLogging): ConfigChange[] {
  const lines: string[] = []
  for (const k of LOG_KINDS) {
    const line = targetLine(k, b.targets[k])
    if (line && line !== targetLine(k, a.targets[k])) lines.push(line)
  }
  if (b.export && b.export !== a.export) lines.push(`logging ${b.export}`)
  if (!lines.length) return []
  return [
    {
      path: CGNAT_PATH,
      lines,
      label: "CGNAT log export",
      warning: disablesNeverEnabledSyslog(a, b) ? SYSLOG_DISABLE_WARNING : undefined,
    },
  ]
}

/** What remaps the pool's subscribers: a new block size, or prefixes added or taken away. */
export function remapReasons(a: PoolConfig | null, b: PoolConfig): string[] {
  if (!a) return []
  const out: string[] = []
  if (b.scalars["block-size"].trim() !== a.scalars["block-size"]) out.push("block size")
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((v) => y.includes(v))
  if (!same(a.inside, b.inside.map((x) => x.trim()))) out.push("inside prefixes")
  if (!same(a.outside, b.outside.map((x) => x.trim()))) out.push("outside prefixes")
  return out
}

export const remapWarning = (what: string) =>
  `Changing the ${what} remaps subscribers: they get a different public address or port block. The review asks you to acknowledge it.`

/** The lines that take a pool from `a` (null: a new pool) to `b`. */
export function poolChanges(a: PoolConfig | null, b: PoolConfig): ConfigChange[] {
  const was = a ?? emptyPool(b.name)
  const lines: string[] = []
  const list = (key: string, from: string[], to: string[]) => {
    const t = to.map((x) => x.trim()).filter(Boolean)
    for (const x of from) if (!t.includes(x)) lines.push(`no ${key} ${x}`)
    for (const x of t) if (!from.includes(x)) lines.push(`${key} ${x}`)
  }
  list("prefix-inside", was.inside, b.inside)
  list("prefix-outside", was.outside, b.outside)
  for (const k of POOL_SCALARS) {
    const v = b.scalars[k].trim().replace(/\s+/g, " ")
    if (v === was.scalars[k]) continue
    if (v) lines.push(`${k} ${v}`)
    else if (!NO_UNSET.includes(k)) lines.push(`no ${k}`)
  }
  for (const alg of ALGS) {
    const v = b.algs[alg]
    if (v === was.algs[alg]) continue
    lines.push(v ? `alg ${alg} ${v}` : `no alg ${alg} ${was.algs[alg]}`)
  }
  if (!lines.length) return []
  const remap = remapReasons(a, b)
  return [
    {
      path: poolPath(b.name.trim()),
      lines,
      label: a ? `pool ${b.name}` : `new pool ${b.name}`,
      warning: remap.length ? remapWarning(remap.join(" and ")) : undefined,
    },
  ]
}

export function poolRemoval(p: PoolConfig): ConfigChange {
  return {
    path: CGNAT_PATH,
    lines: [`no pool ${p.name}`],
    label: `remove pool ${p.name}`,
    warning: "Removing the pool remaps its subscribers. The review asks you to acknowledge it.",
  }
}
