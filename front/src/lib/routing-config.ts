/**
 * The routing configuration the Routing tab's forms edit (#42, #43): BGP,
 * OSPF, OSPF6 and static routes, read from the running configuration's tree
 * (#39) and written back as VTY lines.
 *
 * Reads (`readRouting`) and the lines each change takes (`*Edits`) are the
 * only places that know the statements; the syntax is the VTY's own, from
 * config_grammar.json. When Prisma serves typed routing reads (#558 phase 9),
 * only `readRouting` changes.
 */

import type { ConfigChange } from "@/hooks/use-config-changes"
import { invalid, type Instance } from "@/lib/config-model"

/** A change the routing forms stage: a ConfigChange whose label defaults to its lines. */
export type StagedEdit = Omit<ConfigChange, "label"> & { label?: string }

/** The ConfigChange to stage; an edit with no label is listed by its lines. */
export function toChange(e: StagedEdit): ConfigChange {
  return { ...e, label: e.label ?? e.lines.join("; ") }
}

const words = (s: string) => s.trim().split(/\s+/)

/** `old` replaced by `next` (either may be absent): what to send, in order. */
function replace(old: string | undefined, next: string | undefined): string[] {
  if (old === next) return []
  if (old === undefined) return next === undefined ? [] : [next]
  return next === undefined ? [`no ${old}`] : [`no ${old}`, next]
}

// --- BGP (#42) -------------------------------------------------------------

export type Afi = "ipv4" | "ipv6"
export const AFIS: Afi[] = ["ipv4", "ipv6"]

/** Global switches of `router bgp`, by their line. */
export const BGP_FLAGS = [
  ["bgp log-neighbor-changes", "Log neighbor changes"],
  ["bgp graceful-shutdown", "Graceful shutdown"],
  ["bgp default ipv4-unicast", "Activate neighbors in IPv4 unicast by default"],
  ["bgp bestpath as-path multipath-relax", "Multipath across different neighbor ASes"],
] as const

export const BGP_REDISTRIBUTE = ["connected", "static", "ospf", "isis"] as const

/**
 * A neighbor's settings in `router bgp`, by attribute (`remote-as`,
 * `description`, `bfd`…): the value after it ("" for a switch), and the line
 * that set it.
 */
export type Attrs = Record<string, string>

export interface BgpNeighborConfig {
  address: string
  attrs: Attrs
  lines: Record<string, string>
  /** Per address family: `activate`, `route-map`, `prefix-list`, `soft-reconfiguration`. */
  families: Record<Afi, { attrs: Attrs; lines: Record<string, string> }>
}

/** A configured line and where it is (a network may sit in `router bgp` or in its family). */
export interface Placed {
  path: string[]
  line: string
}

export interface BgpNetwork extends Placed {
  prefix: string
  policy?: string
  summaryOnly?: boolean
  suppressPolicy?: string
}

export interface BgpFamily {
  afi: Afi
  /** The path its lines go to: `router bgp <asn>` › `address-family <afi> unicast`. */
  path: string[]
  networks: BgpNetwork[]
  aggregates: BgpNetwork[]
  redistribute: Partial<Record<(typeof BGP_REDISTRIBUTE)[number], Placed>>
}

export interface BgpConfig {
  asn: string
  path: string[]
  routerId?: string
  /** Lines of BGP_FLAGS that are set. */
  flags: Set<string>
  neighbors: BgpNeighborConfig[]
  families: Record<Afi, BgpFamily>
}

// --- OSPF and OSPF6 (#43) --------------------------------------------------

export type OspfVersion = "ospf" | "ospf6"

export const OSPF_REDISTRIBUTE = ["connected", "static", "bgp", "isis"] as const

export interface OspfRedistribute {
  line: string
  metric?: string
  metricType?: string
  routeMap?: string
}

/** OSPF on one interface: the interface's own statements (`ip ospf area`, `ipv6 ospf6 passive`…). */
export interface OspfInterface {
  name: string
  path: string[]
  area?: string
  cost?: string
  /** The line that makes it passive: the interface's, or OSPFv2's `passive-interface` in the router. */
  passive?: Placed
  lines: Record<"area" | "cost", string | undefined>
}

export interface OspfConfig {
  version: OspfVersion
  path: string[]
  configured: boolean
  routerId?: string
  areas: { area: string; line: string }[]
  /** OSPFv2's `network <prefix> area <area>`; OSPF6 puts interfaces in areas instead. */
  networks: { prefix: string; area: string; line: string }[]
  redistribute: Partial<Record<(typeof OSPF_REDISTRIBUTE)[number], OspfRedistribute>>
  interfaces: OspfInterface[]
}

// --- Static routes (#43) ---------------------------------------------------

export const STATIC_PATH = ["router static"]

export interface StaticRoute {
  prefix: string
  /** An address of the prefix's family, or an interface. */
  nextHop: string
  distance?: string
  tag?: string
  description?: string
  family: 4 | 6
  line: string
}

export interface RoutingConfig {
  bgp: BgpConfig | null
  ospf: OspfConfig
  ospf6: OspfConfig
  statics: StaticRoute[]
  /** Interfaces of the configuration, for the OSPF and next-hop choices. */
  interfaces: string[]
}

// --- Reading ---------------------------------------------------------------

function readNeighbor(list: BgpNeighborConfig[], address: string) {
  let n = list.find((x) => x.address === address)
  if (!n) {
    n = {
      address,
      attrs: {},
      lines: {},
      families: { ipv4: { attrs: {}, lines: {} }, ipv6: { attrs: {}, lines: {} } },
    }
    list.push(n)
  }
  return n
}

/** `network`, `aggregate-address` and `redistribute` of a BGP mode, into its family. */
function readFamilyLine(f: BgpFamily, path: string[], line: string) {
  const w = words(line)
  const opt = (k: string) => {
    const i = w.indexOf(k)
    return i > 0 ? w[i + 1] : undefined
  }
  if (w[0] === "network" && w[1]) f.networks.push({ path, line, prefix: w[1], policy: opt("policy") })
  else if (w[0] === "aggregate-address" && w[1])
    f.aggregates.push({ path, line, prefix: w[1], summaryOnly: w.includes("summary-only"), policy: opt("policy"), suppressPolicy: opt("suppress-policy") })
  else if (w[0] === "redistribute" && (BGP_REDISTRIBUTE as readonly string[]).includes(w[1]))
    f.redistribute[w[1] as (typeof BGP_REDISTRIBUTE)[number]] = { path, line }
  else return false
  return true
}

function readBgp(instances: Instance[]): BgpConfig | null {
  const top = instances.find((i) => i.path.length === 1 && i.path[0].startsWith("router bgp "))
  if (!top) return null
  const path = top.path
  const family = (afi: Afi): BgpFamily => ({ afi, path: [...path, `address-family ${afi} unicast`], networks: [], aggregates: [], redistribute: {} })
  const bgp: BgpConfig = {
    asn: words(path[0])[2],
    path,
    flags: new Set(),
    neighbors: [],
    families: { ipv4: family("ipv4"), ipv6: family("ipv6") },
  }
  for (const { text } of top.lines) {
    const w = words(text)
    if (w[0] === "bgp" && w[1] === "router-id") bgp.routerId = w[2]
    else if (BGP_FLAGS.some(([f]) => f === text)) bgp.flags.add(text)
    else if (w[0] === "neighbor" && w[1]) {
      const n = readNeighbor(bgp.neighbors, w[1])
      if (w[2]) {
        n.attrs[w[2]] = w.slice(3).join(" ")
        n.lines[w[2]] = text
      }
    } else readFamilyLine(bgp.families.ipv4, path, text) // `router bgp` itself is IPv4 unicast
  }
  for (const afi of AFIS) {
    const inst = instances.find((i) => i.path.length === 2 && i.path[0] === path[0] && i.path[1] === `address-family ${afi} unicast`)
    for (const { text } of inst?.lines ?? []) {
      const w = words(text)
      if (w[0] === "neighbor" && w[1] && w[2]) {
        const f = readNeighbor(bgp.neighbors, w[1]).families[afi]
        f.attrs[w[2]] = w.slice(3).join(" ")
        f.lines[w[2]] = text
      } else readFamilyLine(bgp.families[afi], bgp.families[afi].path, text)
    }
  }
  return bgp
}

const ifaceName = (i: Instance) => i.path[0].slice("interface ".length)

function readOspf(instances: Instance[], version: OspfVersion): OspfConfig {
  const path = [version === "ospf" ? "router ospf" : "router ospf6"]
  const inst = instances.find((i) => i.path.length === 1 && i.path[0] === path[0])
  const c: OspfConfig = { version, path, configured: !!inst, areas: [], networks: [], redistribute: {}, interfaces: [] }
  const routerPassive = new Map<string, string>()
  for (const { text } of inst?.lines ?? []) {
    const w = words(text)
    if (w[0] === version && w[1] === "router-id") c.routerId = w[2]
    else if (w[0] === "area" && w.length === 2) c.areas.push({ area: w[1], line: text })
    else if (w[0] === "network" && w[2] === "area") c.networks.push({ prefix: w[1], area: w[3], line: text })
    else if (w[0] === "passive-interface" && w[1]) routerPassive.set(w[1], text)
    else if (w[0] === "redistribute" && (OSPF_REDISTRIBUTE as readonly string[]).includes(w[1])) {
      const opt = (k: string) => {
        const i = w.indexOf(k)
        return i > 0 ? w[i + 1] : undefined
      }
      c.redistribute[w[1] as (typeof OSPF_REDISTRIBUTE)[number]] = {
        line: text,
        metric: opt("metric"),
        metricType: opt("metric-type"),
        routeMap: opt("route-map"),
      }
    }
  }
  const lead = version === "ospf" ? ["ip", "ospf"] : ["ipv6", "ospf6"]
  for (const i of instances.filter((i) => i.path.length === 1 && i.path[0].startsWith("interface "))) {
    const name = ifaceName(i)
    const o: OspfInterface = { name, path: i.path, lines: { area: undefined, cost: undefined } }
    for (const { text } of i.lines) {
      const w = words(text)
      if (w[0] !== lead[0] || w[1] !== lead[1]) continue
      if (w[2] === "area") [o.area, o.lines.area] = [w[3], text]
      else if (w[2] === "cost") [o.cost, o.lines.cost] = [w[3], text]
      else if (w[2] === "passive") o.passive = { path: i.path, line: text }
    }
    const rp = routerPassive.get(name)
    if (!o.passive && rp) o.passive = { path, line: rp }
    c.interfaces.push(o)
  }
  return c
}

function readStatics(instances: Instance[]): StaticRoute[] {
  const inst = instances.find((i) => i.path.length === 1 && i.path[0] === STATIC_PATH[0])
  const out: StaticRoute[] = []
  for (const { text } of inst?.lines ?? []) {
    const w = words(text)
    if (w[1] !== "next-hop" || !w[2]) continue
    const opt = (k: string) => {
      const i = w.indexOf(k, 3)
      return i > 0 ? w[i + 1] : undefined
    }
    const d = w.indexOf("description", 3)
    out.push({
      prefix: w[0],
      nextHop: w[2],
      distance: opt("distance"),
      tag: opt("tag"),
      description: d > 0 ? w.slice(d + 1).join(" ") : undefined,
      family: w[0].includes(":") ? 6 : 4,
      line: text,
    })
  }
  return out
}

/** The routing configuration, from the running configuration's tree (/config/tree). */
export function readRouting(instances: Instance[]): RoutingConfig {
  return {
    bgp: readBgp(instances),
    ospf: readOspf(instances, "ospf"),
    ospf6: readOspf(instances, "ospf6"),
    statics: readStatics(instances),
    interfaces: instances.filter((i) => i.path.length === 1 && i.path[0].startsWith("interface ")).map(ifaceName),
  }
}

// --- Writing ---------------------------------------------------------------

/** A new BGP process: `router bgp <asn>` with its router ID. */
export function bgpCreateEdits(asn: string, routerId: string): StagedEdit[] {
  return [{ path: [`router bgp ${asn}`], lines: [`bgp router-id ${routerId}`], label: `start BGP AS ${asn}` }]
}

export function bgpGlobalEdits(bgp: BgpConfig, routerId: string, flags: Set<string>): StagedEdit[] {
  const lines = replace(bgp.routerId ? `bgp router-id ${bgp.routerId}` : undefined, routerId ? `bgp router-id ${routerId}` : undefined)
  for (const [f] of BGP_FLAGS) {
    if (flags.has(f) !== bgp.flags.has(f)) lines.push(flags.has(f) ? f : `no ${f}`)
  }
  return [{ path: bgp.path, lines, label: "BGP global settings" }]
}

/** Neighbor attributes that are switches: present with no value. */
export const NEIGHBOR_SWITCHES = ["next-hop-self", "bfd", "shutdown"] as const
/** Neighbor attributes the form edits, in the order the lines are sent (`remote-as` first: it creates the neighbor). */
export const NEIGHBOR_ATTRS = [
  "remote-as",
  "peer-group",
  "description",
  "password",
  "update-source",
  "ebgp-multihop",
  "timers",
  "maximum-prefix",
  ...NEIGHBOR_SWITCHES,
] as const
export const FAMILY_ATTRS = ["activate", "route-map", "prefix-list", "soft-reconfiguration"] as const

/** What the neighbor form gives: attributes (absent: not set) for the neighbor and per family. */
export interface NeighborForm {
  address: string
  attrs: Attrs
  families: Record<Afi, Attrs>
}

function attrLine(address: string, attr: string, value: string) {
  return `neighbor ${address} ${attr}${value ? ` ${value}` : ""}`
}

/**
 * The lines that turn a neighbor's configuration into the form's: the
 * neighbor's in `router bgp`, then each family's. A changed `remote-as` is
 * sent as the new line alone: `no neighbor … remote-as` removes the whole
 * neighbor on FRR.
 */
export function neighborEdits(bgp: BgpConfig, before: BgpNeighborConfig | undefined, form: NeighborForm): StagedEdit[] {
  const a = form.address
  const lines: string[] = []
  for (const attr of NEIGHBOR_ATTRS) {
    const old = before?.lines[attr]
    const value = form.attrs[attr]
    const next = value === undefined ? undefined : attrLine(a, attr, value)
    if (attr === "remote-as" && old && next) {
      if (old !== next) lines.push(next)
    } else lines.push(...replace(old, next))
  }
  const out: StagedEdit[] = [{ path: bgp.path, lines, label: `neighbor ${a}` }]
  for (const afi of AFIS) {
    const fl: string[] = []
    for (const attr of FAMILY_ATTRS) {
      const old = before?.families[afi].lines[attr]
      const value = form.families[afi][attr]
      fl.push(...replace(old, value === undefined ? undefined : attrLine(a, attr, value)))
    }
    out.push({ path: bgp.families[afi].path, lines: fl, label: `neighbor ${a} (${afi})` })
  }
  return out
}

export function neighborShutdownEdits(bgp: BgpConfig, n: BgpNeighborConfig, down: boolean): StagedEdit[] {
  const line = `neighbor ${n.address} shutdown`
  return [{ path: bgp.path, lines: [down ? line : `no ${line}`], label: `${down ? "shut down" : "enable"} ${n.address}` }]
}

/** `no neighbor <address>`: the neighbor and its lines in every family. */
export function neighborRemoveEdits(bgp: BgpConfig, n: BgpNeighborConfig): StagedEdit[] {
  return [{ path: bgp.path, lines: [`no neighbor ${n.address}`], label: `remove ${n.address}` }]
}

export function networkLine(prefix: string, policy: string) {
  return `network ${prefix}${policy ? ` policy ${policy}` : ""}`
}

export function aggregateLine(prefix: string, summaryOnly: boolean, policy: string, suppressPolicy: string) {
  return [
    `aggregate-address ${prefix}`,
    summaryOnly && "summary-only",
    policy && `policy ${policy}`,
    suppressPolicy && `suppress-policy ${suppressPolicy}`,
  ]
    .filter(Boolean)
    .join(" ")
}

export function addLineEdits(path: string[], line: string): StagedEdit[] {
  return [{ path, lines: [line] }]
}

export function removeLineEdits(p: Placed): StagedEdit[] {
  return [{ path: p.path, lines: [`no ${p.line}`] }]
}

export function bgpRedistributeEdits(f: BgpFamily, proto: (typeof BGP_REDISTRIBUTE)[number], on: boolean): StagedEdit[] {
  const cur = f.redistribute[proto]
  if (on === !!cur) return []
  return on ? [{ path: f.path, lines: [`redistribute ${proto}`] }] : removeLineEdits(cur!)
}

/** OSPF's `redistribute <proto> [metric <n>] [metric-type 1|2] [route-map <name>]`; OSPF6 takes the route map only. */
export function ospfRedistributeLine(version: OspfVersion, proto: string, r: { metric?: string; metricType?: string; routeMap?: string }) {
  const parts = [`redistribute ${proto}`]
  if (version === "ospf" && r.metric) parts.push(`metric ${r.metric}`)
  if (version === "ospf" && r.metricType) parts.push(`metric-type ${r.metricType}`)
  if (r.routeMap) parts.push(`route-map ${r.routeMap}`)
  return parts.join(" ")
}

export function ospfRedistributeEdits(c: OspfConfig, proto: (typeof OSPF_REDISTRIBUTE)[number], next: string | undefined): StagedEdit[] {
  return [{ path: c.path, lines: replace(c.redistribute[proto]?.line, next) }]
}

export function ospfRouterIdEdits(c: OspfConfig, routerId: string): StagedEdit[] {
  const id = (v?: string) => (v ? `${c.version} router-id ${v}` : undefined)
  return [{ path: c.path, lines: replace(id(c.routerId), id(routerId || undefined)) }]
}

/**
 * OSPF on an interface: its area, cost and whether it is passive. OSPFv2
 * makes an interface passive in the router (`passive-interface`), OSPF6 on
 * the interface (`ipv6 ospf6 passive`); a passive line already configured is
 * removed where it is.
 */
export function ospfInterfaceEdits(c: OspfConfig, i: OspfInterface, next: { area: string; cost: string; passive: boolean }): StagedEdit[] {
  const lead = c.version === "ospf" ? "ip ospf" : "ipv6 ospf6"
  const lines = [
    ...replace(i.lines.area, next.area ? `${lead} area ${next.area}` : undefined),
    ...replace(i.lines.cost, next.cost ? `${lead} cost ${next.cost}` : undefined),
  ]
  const out: StagedEdit[] = [{ path: i.path, lines, label: `${c.version} on ${i.name}` }]
  if (next.passive && !i.passive) {
    if (c.version === "ospf") out.push({ path: c.path, lines: [`passive-interface ${i.name}`] })
    else lines.push(`${lead} passive`)
  } else if (!next.passive && i.passive) {
    if (i.passive.path[0] === i.path[0]) lines.push(`no ${i.passive.line}`)
    else out.push(...removeLineEdits(i.passive))
  }
  return out
}

export function staticLine(r: { prefix: string; nextHop: string; distance?: string; tag?: string; description?: string }) {
  return [
    `${r.prefix} next-hop ${r.nextHop}`,
    r.distance && `distance ${r.distance}`,
    r.tag && `tag ${r.tag}`,
    r.description && `description ${r.description}`,
  ]
    .filter(Boolean)
    .join(" ")
}

export function staticEdits(before: StaticRoute | undefined, line: string): StagedEdit[] {
  return [{ path: STATIC_PATH, lines: replace(before?.line, line) }]
}

// --- Checks ----------------------------------------------------------------

/** An OSPF area: a number or a dotted quad. */
export function invalidArea(v: string): string | null {
  if (!v.trim()) return "required"
  return /^\d+$/.test(v) && Number(v) <= 4294967295 ? null : invalid({ k: "ipv4" }, v) ? "a number or A.B.C.D" : null
}

export function invalidInt(v: string, min: number, max: number): string | null {
  return invalid({ k: "int", min, max }, v)
}

/** A static route's next hop: an address of the prefix's family, or an interface name. */
export function invalidNextHop(prefix: string, v: string): string | null {
  if (!v.trim()) return "required"
  if (/^[0-9.]+$/.test(v) || v.includes(":")) {
    if (invalid({ k: "address" }, v)) return "an address or an interface"
    if (v.includes(":") !== prefix.includes(":")) return "an address of the prefix's family"
    return null
  }
  return /^[\w.\-/]+$/.test(v) ? null : "an address or an interface"
}
