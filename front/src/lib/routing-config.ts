/**
 * The routing configuration the Routing tab's forms edit (#42, #43): BGP,
 * OSPF, OSPF6 and static routes, read from the running configuration's tree
 * (#39) and written back as VTY lines.
 *
 * Reads (`readRouting`) and the lines each change takes (`*Edits`) are the
 * only places that know the statements; the syntax is the VTY's own, from
 * config_grammar.json. On a box that answers GetConfig's routing areas
 * (Prisma 0.149.22, #46) the configuration is read typed (`readRoutingTyped`,
 * each block's `other` statements kept, read only), static routes and BGP
 * neighbors are written with SetConfig / DeleteConfig naming their fields
 * (`*EditsTyped`), and the rest (BGP's global settings, networks, aggregates,
 * redistribution, OSPF) is still written as lines, as the box asks.
 */

import type { ConfigChange } from "@/hooks/use-config-changes"
import { invalid, type Instance } from "@/lib/config-model"
import {
  describeSet,
  n2s,
  s2n,
  typedSet,
  type TypedBgp,
  type TypedBgpNeighbor,
  type TypedBgpNeighborFamily,
  type TypedConfig,
  type TypedOspf,
  type TypedRedistribute,
  type TypedStaticRoute,
} from "@/lib/typed-config"

/** A change the routing forms stage: a ConfigChange whose label defaults to its lines. */
export type StagedEdit = Omit<ConfigChange, "label"> & { label?: string }

/** The ConfigChange to stage; an edit with no label is listed by its lines. */
export function toChange(e: StagedEdit): ConfigChange {
  return { ...e, label: e.label ?? [...e.lines, ...(e.summary ?? [])].join("; ") }
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
  /** Every statement naming the neighbor, where it is (line form), for a removal statement by statement. */
  statements?: Placed[]
  /** Typed (#46): the neighbor as GetConfig read it, and what each family says about it. */
  typed?: TypedBgpNeighbor
  typedFamilies?: Partial<Record<Afi, TypedBgpNeighborFamily>>
  /** Typed: the statements no field takes, at the router level and per family (read only). */
  other?: string[]
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
  /** Typed: the family's statements no field takes (read only). */
  other?: string[]
}

export interface BgpConfig {
  asn: string
  /** "" is the default VRF. */
  vrf?: string
  path: string[]
  /** Read with GetConfig (#46): neighbors are written with SetConfig / DeleteConfig. */
  typed?: boolean
  /** `bgp default ipv4-unicast`, FRR's default: a neighbor is then active in IPv4 unicast with no `activate` line. */
  defaultIpv4Unicast?: boolean
  /** Typed: router-level statements no field takes (read only). */
  other?: string[]
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
  /** Typed (#46): `default-information` and the statements no field takes, area ones included (read only). */
  other?: string[]
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
  /** Typed (#46): a VRF's own route (read only here: a line of its `vrf` block), and FRR's words after the next hop. */
  vrf?: string
  extra?: string[]
}

export interface RoutingConfig {
  bgp: BgpConfig | null
  ospf: OspfConfig
  ospf6: OspfConfig
  statics: StaticRoute[]
  /** Interfaces of the configuration, for the OSPF and next-hop choices. */
  interfaces: string[]
  /** Read with GetConfig (#46). */
  typed?: boolean
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
      ;(n.statements ??= []).push({ path, line: text })
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
        const nb = readNeighbor(bgp.neighbors, w[1])
        ;(nb.statements ??= []).push({ path: bgp.families[afi].path, line: text })
        const f = nb.families[afi]
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
    // An area's own statement: bare before 0.149.24's grammar, with its type since (#47).
    else if (w[0] === "area" && (w.length === 2 || (["stub", "nssa"].includes(w[2]) && (w.length === 3 || (w.length === 4 && w[3] === "no-summary")))))
      c.areas.push({ area: w[1], line: text })
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

/** `0.149.4`, `0.149.0-mock` → [0, 149, 4]; null when it is not a version. */
export function releaseOf(release: string | undefined): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(release?.trim() ?? "")
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

const olderThan = (v: [number, number, number], x: [number, number, number]) => (v[0] !== x[0] ? v[0] < x[0] : v[1] !== x[1] ? v[1] < x[1] : v[2] < x[2])

/**
 * Whether a bare `no neighbor <address>` is safe on this release, for the line
 * form. From 0.149.23 it removes the neighbor and every statement naming it.
 * On 0.149.20 to 0.149.22 the VTY stages it as a statement of its own, which
 * frr-reload refuses next to a family statement (docs/prisma-api.md): there the
 * neighbor goes statement by statement (0.149.22 types it, and the typed form
 * sends DeleteConfig instead). Before 0.149.20, and when the release is not
 * known, the bare line stays what it has always been here.
 */
export function bareNoNeighborSafe(release: string | undefined): boolean {
  const v = releaseOf(release)
  return !v || olderThan(v, [0, 149, 20]) || !olderThan(v, [0, 149, 23])
}

/**
 * The neighbor removed, as lines: `no neighbor <address>` where that is safe
 * (see bareNoNeighborSafe), otherwise each statement naming it, its families'
 * first and `remote-as` last, as DeleteConfig does on 0.149.22.
 */
export function neighborRemoveEdits(bgp: BgpConfig, n: BgpNeighborConfig, release?: string): StagedEdit[] {
  if (bareNoNeighborSafe(release) || !n.statements?.length) {
    return [{ path: bgp.path, lines: [`no neighbor ${n.address}`], label: `remove ${n.address}` }]
  }
  const all = n.statements
  const top = all.filter((p) => p.path.length === 1)
  const remote = top.filter((p) => words(p.line)[2] === "remote-as")
  const out: StagedEdit[] = AFIS.map((afi) => ({
    path: bgp.families[afi].path,
    lines: all.filter((p) => p.path.join(">") === bgp.families[afi].path.join(">")).map((p) => `no ${p.line}`),
    label: `remove ${n.address} (${afi})`,
  })).filter((e) => e.lines.length > 0)
  out.push({ path: bgp.path, lines: [...top.filter((p) => !remote.includes(p)), ...remote].map((p) => `no ${p.line}`), label: `remove ${n.address}` })
  return out
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

/** A neighbor's route map or prefix list in a family: the name, then the direction (FRR's `<name> in|out`, #47). */
export function invalidDirected(v: string): string | null {
  if (!v.trim()) return null
  return /^\S+ (in|out)$/.test(v.trim().replace(/\s+/g, " ")) ? null : "the name, then in or out"
}

/** An area's own statement: FRR declares an area only with a type (`area 0.0.0.1 stub`), #47. */
export function areaLine(area: string, type: "stub" | "nssa", noSummary: boolean): string {
  return [`area ${area.trim()}`, type, noSummary && "no-summary"].filter(Boolean).join(" ")
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

// --- Typed (Prisma 0.149.22, #46) ------------------------------------------------

const AFI_OF = (afi: string): Afi | null => (afi === "ipv4" || afi === "ipv6" ? afi : null)

function placedRedistribute(path: string[], r: TypedRedistribute): Placed {
  return { path, line: r.statement || `redistribute ${r.protocol}` }
}

/** A typed neighbor's settings as the line model's attributes, for the lists and badges. */
function attrsOfTyped(n: TypedBgpNeighbor): Attrs {
  const a: Attrs = {}
  if (n.remote_as) a["remote-as"] = n.remote_as
  if (n.peer_group) a["peer-group"] = n.peer_group
  if (n.description) a.description = n.description
  if (n.password_set) a.password = ""
  if (n.update_source) a["update-source"] = n.update_source
  if (n.ebgp_multihop) a["ebgp-multihop"] = String(n.ebgp_multihop)
  if (n.keepalive || n.holdtime) a.timers = `${n.keepalive} ${n.holdtime}`
  if (n.bfd) a.bfd = ""
  if (n.shutdown) a.shutdown = ""
  return a
}

function familyAttrsOfTyped(f: TypedBgpNeighborFamily | undefined, active: boolean): Attrs {
  const a: Attrs = {}
  if (active) a.activate = ""
  if (!f) return a
  if (f.route_map_in) a["route-map"] = `${f.route_map_in} in`
  else if (f.route_map_out) a["route-map"] = `${f.route_map_out} out`
  if (f.prefix_list_in) a["prefix-list"] = `${f.prefix_list_in} in`
  else if (f.prefix_list_out) a["prefix-list"] = `${f.prefix_list_out} out`
  if (f.soft_reconfiguration_inbound) a["soft-reconfiguration"] = "inbound"
  if (f.next_hop_self) a["next-hop-self"] = ""
  return a
}

/**
 * Whether a family activates the neighbor: what it states, and in IPv4
 * unicast FRR's default (`bgp default ipv4-unicast`, on unless `no bgp default
 * ipv4-unicast`) unless the family says `no neighbor … activate`.
 */
export function activeIn(bgp: Pick<BgpConfig, "defaultIpv4Unicast">, afi: Afi, address: string, f?: TypedBgpNeighborFamily) {
  if (f?.activate) return true
  if (afi !== "ipv4" || !bgp.defaultIpv4Unicast) return false
  return !(f?.other ?? []).some((l) => l.trim() === `no neighbor ${address} activate`)
}

function bgpFromTyped(t: TypedBgp): BgpConfig {
  const head = t.vrf ? `router bgp ${t.asn} vrf ${t.vrf}` : `router bgp ${t.asn}`
  const path = [head]
  const family = (afi: Afi): BgpFamily => ({ afi, path: [...path, `address-family ${afi} unicast`], networks: [], aggregates: [], redistribute: {}, other: [] })
  const flags = new Set<string>()
  const other: string[] = []
  for (const l of t.other) {
    if (BGP_FLAGS.some(([f]) => f === l.trim())) flags.add(l.trim())
    else other.push(l)
  }
  if (t.default_ipv4_unicast) flags.add("bgp default ipv4-unicast")
  const bgp: BgpConfig = {
    asn: t.asn,
    vrf: t.vrf,
    path,
    typed: true,
    defaultIpv4Unicast: t.default_ipv4_unicast,
    routerId: t.router_id || undefined,
    flags,
    other,
    neighbors: [],
    families: { ipv4: family("ipv4"), ipv6: family("ipv6") },
  }
  for (const f of t.families) {
    const afi = AFI_OF(f.afi)
    if (!afi || f.safi !== "unicast") {
      // Another family (l2vpn evpn, multicast): listed as it is, read only.
      bgp.other!.push(`address-family ${f.afi} ${f.safi}: ${[...f.networks.map((x) => `network ${x}`), ...f.other].join("; ") || "(no statement)"}`)
      continue
    }
    const fam = bgp.families[afi]
    fam.networks = f.networks.map((x) => {
      const w = words(x)
      const i = w.indexOf("policy")
      return { path: fam.path, line: `network ${x}`, prefix: w[0], policy: i > 0 ? w[i + 1] : undefined }
    })
    fam.aggregates = f.aggregates.map((a) => ({
      path: fam.path,
      line: [`aggregate-address ${a.prefix}`, a.as_set && "as-set", a.summary_only && "summary-only"].filter(Boolean).join(" "),
      prefix: a.prefix,
      summaryOnly: a.summary_only,
    }))
    for (const r of f.redistribute) {
      if ((BGP_REDISTRIBUTE as readonly string[]).includes(r.protocol)) fam.redistribute[r.protocol as (typeof BGP_REDISTRIBUTE)[number]] = placedRedistribute(fam.path, r)
      else fam.other!.push(r.statement)
    }
    fam.other!.push(...f.other)
  }
  for (const n of t.neighbors) {
    const typedFamilies: Partial<Record<Afi, TypedBgpNeighborFamily>> = {}
    for (const f of t.families) {
      const afi = AFI_OF(f.afi)
      const nf = f.neighbors.find((x) => x.neighbor === n.address)
      if (afi && f.safi === "unicast" && nf) typedFamilies[afi] = nf
    }
    const fam = (afi: Afi) => ({ attrs: familyAttrsOfTyped(typedFamilies[afi], activeIn(bgp, afi, n.address, typedFamilies[afi])), lines: {} })
    bgp.neighbors.push({
      address: n.address,
      attrs: attrsOfTyped(n),
      lines: {},
      families: { ipv4: fam("ipv4"), ipv6: fam("ipv6") },
      typed: n,
      typedFamilies,
      other: [...n.other, ...AFIS.flatMap((afi) => (typedFamilies[afi]?.other ?? []).map((l) => `${afi}: ${l}`))],
    })
  }
  return bgp
}

function ospfFromTyped(version: OspfVersion, t: TypedOspf | undefined, ifRouting: TypedConfig["interface_routing"], interfaces: string[]): OspfConfig {
  const path = [version === "ospf" ? "router ospf" : "router ospf6"]
  const c: OspfConfig = { version, path, configured: !!t, areas: [], networks: [], redistribute: {}, interfaces: [], other: [] }
  if (t) {
    c.routerId = t.router_id || undefined
    c.networks = t.networks.map((n) => ({ prefix: n.prefix, area: n.area, line: `network ${n.prefix} area ${n.area}` }))
    c.areas = t.areas.map((a) => ({
      area: a.area,
      line: [`area ${a.area}`, a.area_type !== "normal" && a.area_type, a.no_summary && "no-summary"].filter(Boolean).join(" "),
    }))
    for (const r of t.redistribute) {
      if ((OSPF_REDISTRIBUTE as readonly string[]).includes(r.protocol)) {
        c.redistribute[r.protocol as (typeof OSPF_REDISTRIBUTE)[number]] = {
          line: r.statement,
          metric: r.metric ? String(r.metric) : undefined,
          metricType: r.metric_type || undefined,
          routeMap: r.route_map || undefined,
        }
      } else c.other!.push(r.statement)
    }
    if (t.passive_default) c.other!.push("passive-interface default")
    c.other!.push(...t.not_passive.map((i) => `no passive-interface ${i}`))
    if (t.default_information) c.other!.push(t.default_information)
    c.other!.push(...t.areas.flatMap((a) => a.other), ...t.other)
  }
  const v2 = version === "ospf"
  const lead = v2 ? "ip ospf" : "ipv6 ospf6"
  for (const name of interfaces) {
    const r = ifRouting.find((x) => x.name === name)
    const area = (v2 ? r?.ospf_area : r?.ospf6_area) || undefined
    const cost = n2s(v2 ? r?.ospf_cost : r?.ospf6_cost) || undefined
    const ipath = [`interface ${name}`]
    const o: OspfInterface = {
      name,
      path: ipath,
      area,
      cost,
      lines: { area: area && `${lead} area ${area}`, cost: cost && `${lead} cost ${cost}` },
    }
    if (v2 ? r?.ospf_passive : r?.ospf6_passive) o.passive = { path: ipath, line: `${lead} passive` }
    else if (v2 && t?.passive.includes(name)) o.passive = { path, line: `passive-interface ${name}` }
    c.interfaces.push(o)
  }
  return c
}

function staticFromTyped(r: TypedStaticRoute): StaticRoute {
  return {
    prefix: r.prefix,
    nextHop: r.next_hop,
    distance: n2s(r.distance) || undefined,
    tag: n2s(r.tag) || undefined,
    description: r.description || undefined,
    family: r.family === "ipv6" || r.prefix.includes(":") ? 6 : 4,
    line: r.line,
    vrf: r.vrf || undefined,
    extra: r.extra.length ? r.extra : undefined,
  }
}

/** The routing configuration from GetConfig's routing areas and its interfaces (#46). */
export function readRoutingTyped(t: TypedConfig): RoutingConfig {
  const interfaces = [...new Set([...t.interfaces.map((i) => i.name), ...t.interface_routing.map((i) => i.name)])]
  // The forms edit the default VRF's process; another VRF's is listed by its sessions above.
  const bgp = t.bgp.find((b) => !b.vrf) ?? null
  return {
    bgp: bgp && bgpFromTyped(bgp),
    ospf: ospfFromTyped("ospf", t.ospf.find((o) => !o.vrf), t.interface_routing, interfaces),
    ospf6: ospfFromTyped("ospf6", t.ospf6.find((o) => !o.vrf), t.interface_routing, interfaces),
    statics: t.static_routes.map(staticFromTyped),
    interfaces,
    typed: true,
  }
}

/** The typed neighbor form: router-level fields, and per family what it says about the neighbor. */
export interface TypedNeighborFamilyForm {
  activate: boolean
  routeMapIn: string
  routeMapOut: string
  prefixListIn: string
  prefixListOut: string
  maximumPrefix: string
  nextHopSelf: boolean
  softReconfiguration: boolean
}

export interface TypedNeighborForm {
  address: string
  remoteAs: string
  peerGroup: string
  description: string
  /** Write only: "" keeps the password the box has (it is never read). */
  password: string
  updateSource: string
  ebgpMultihop: string
  keepalive: string
  hold: string
  bfd: boolean
  shutdown: boolean
  families: Record<Afi, TypedNeighborFamilyForm>
}

/** The form's state for a neighbor read typed (or a new one); the password is always empty. */
export function typedNeighborForm(bgp: BgpConfig, n?: BgpNeighborConfig): TypedNeighborForm {
  const t = n?.typed
  const fam = (afi: Afi): TypedNeighborFamilyForm => {
    const f = n?.typedFamilies?.[afi]
    return {
      activate: n ? activeIn(bgp, afi, n.address, f) : false,
      routeMapIn: f?.route_map_in ?? "",
      routeMapOut: f?.route_map_out ?? "",
      prefixListIn: f?.prefix_list_in ?? "",
      prefixListOut: f?.prefix_list_out ?? "",
      maximumPrefix: n2s(f?.maximum_prefix),
      nextHopSelf: !!f?.next_hop_self,
      softReconfiguration: !!f?.soft_reconfiguration_inbound,
    }
  }
  return {
    address: n?.address ?? "",
    remoteAs: t?.remote_as ?? "",
    peerGroup: t?.peer_group ?? "",
    description: t?.description ?? "",
    password: "",
    updateSource: t?.update_source ?? "",
    ebgpMultihop: n2s(t?.ebgp_multihop),
    keepalive: n2s(t?.keepalive),
    hold: n2s(t?.holdtime),
    bfd: !!t?.bfd,
    shutdown: !!t?.shutdown,
    families: { ipv4: fam("ipv4"), ipv6: fam("ipv6") },
  }
}

const FAMILY_KEYS: (keyof TypedNeighborFamilyForm)[] = [
  "activate",
  "routeMapIn",
  "routeMapOut",
  "prefixListIn",
  "prefixListOut",
  "maximumPrefix",
  "nextHopSelf",
  "softReconfiguration",
]

/**
 * The SetConfig for a neighbor: the fields that differ from what the box read
 * (all the set ones for a new neighbor), the password only when typed, and
 * each family that changed listed whole: its settings start from what the
 * box read, so a field the form does not show (default-originate) is kept.
 */
export function neighborEditsTyped(bgp: BgpConfig, before: BgpNeighborConfig | undefined, form: TypedNeighborForm): StagedEdit[] {
  const was = typedNeighborForm(bgp, before)
  const f = (v: string) => v.trim()
  const fields: string[] = []
  const changed = (a: string, b: string) => f(a) !== f(b)
  if (changed(was.remoteAs, form.remoteAs) && f(form.remoteAs)) fields.push("remote_as")
  if (changed(was.description, form.description)) fields.push("description")
  if (changed(was.updateSource, form.updateSource)) fields.push("update_source")
  if (changed(was.keepalive, form.keepalive) || changed(was.hold, form.hold)) fields.push("timers")
  if (f(form.password)) fields.push("password")
  if (changed(was.peerGroup, form.peerGroup)) fields.push("peer_group")
  if (changed(was.ebgpMultihop, form.ebgpMultihop)) fields.push("ebgp_multihop")
  if (was.shutdown !== form.shutdown) fields.push("shutdown")
  if (was.bfd !== form.bfd) fields.push("bfd")
  const families = AFIS.filter((afi) => FAMILY_KEYS.some((k) => String(was.families[afi][k]).trim() !== String(form.families[afi][k]).trim())).map((afi) => {
    const x = form.families[afi]
    const read = before?.typedFamilies?.[afi]
    return {
      afi,
      safi: "unicast",
      settings: {
        ...read,
        neighbor: form.address,
        activate: x.activate,
        route_map_in: f(x.routeMapIn),
        route_map_out: f(x.routeMapOut),
        prefix_list_in: f(x.prefixListIn),
        prefix_list_out: f(x.prefixListOut),
        maximum_prefix: s2n(x.maximumPrefix),
        next_hop_self: x.nextHopSelf,
        soft_reconfiguration_inbound: x.softReconfiguration,
      },
    }
  })
  if (families.length) fields.push("families")
  if (!fields.length) return [{ path: bgp.path, lines: [], label: `neighbor ${form.address}` }]
  const neighbor: Partial<TypedBgpNeighbor> & { address: string } = {
    address: form.address,
    remote_as: f(form.remoteAs),
    description: f(form.description),
    update_source: f(form.updateSource),
    keepalive: s2n(form.keepalive),
    holdtime: s2n(form.hold),
    peer_group: f(form.peerGroup),
    ebgp_multihop: s2n(form.ebgpMultihop),
    shutdown: form.shutdown,
    bfd: form.bfd,
  }
  const edit = {
    asn: bgp.asn,
    vrf: bgp.vrf ?? "",
    neighbor,
    families,
    // Write only: sent when typed, never otherwise, so an empty field never clears it.
    ...(f(form.password) ? { password: f(form.password) } : {}),
  }
  const shown: Record<string, unknown> = { ...neighbor, timers: `${neighbor.keepalive} ${neighbor.holdtime}`, families: families.map((x) => `${x.afi} ${x.safi}`) }
  return [
    {
      path: bgp.path,
      lines: [],
      typed: [typedSet({ bgp_neighbor: edit }, fields)],
      summary: [`neighbor ${form.address}:`, ...describeSet(fields, shown)],
      label: `neighbor ${form.address}`,
    },
  ]
}

export function neighborShutdownEditsTyped(bgp: BgpConfig, n: BgpNeighborConfig, down: boolean): StagedEdit[] {
  const edit = { asn: bgp.asn, vrf: bgp.vrf ?? "", neighbor: { address: n.address, shutdown: down } }
  return [{ path: bgp.path, lines: [], typed: [typedSet({ bgp_neighbor: edit }, ["shutdown"])], summary: [`neighbor ${n.address} shutdown ${down}`], label: `${down ? "shut down" : "enable"} ${n.address}` }]
}

/**
 * DeleteConfig: the box removes the neighbor statement by statement, each
 * family's first and `remote-as` last; a bare `no neighbor` next to family
 * statements is refused by frr-reload on such a box.
 */
export function neighborRemoveEditsTyped(bgp: BgpConfig, n: BgpNeighborConfig): StagedEdit[] {
  return [
    {
      path: bgp.path,
      lines: [],
      typed: [{ remove: { area: "bgp", name: n.address, asn: bgp.asn, vrf: bgp.vrf ?? "" } }],
      summary: [`remove neighbor ${n.address}`],
      label: `remove ${n.address}`,
    },
  ]
}

/** The static route form's values. */
export interface StaticForm {
  prefix: string
  nextHop: string
  distance: string
  tag: string
  description: string
}

/**
 * A route IS its prefix and next hop: the same pair is set again whole (the
 * fields named, the rest kept by the box); a new pair is a new route, and the
 * old one is removed with DeleteConfig.
 */
export function staticEditsTyped(before: StaticRoute | undefined, r: StaticForm): StagedEdit[] {
  const route = { prefix: r.prefix, next_hop: r.nextHop, distance: s2n(r.distance), tag: s2n(r.tag), description: r.description }
  const fields = ["distance", "tag", "description"]
  const typed = []
  const summary: string[] = []
  if (before && (before.prefix !== r.prefix || before.nextHop !== r.nextHop)) {
    typed.push({ remove: { area: "static" as const, prefix: before.prefix, next_hop: before.nextHop } })
    summary.push(`remove ${before.prefix} via ${before.nextHop};`)
  }
  typed.push(typedSet({ static_route: route }, fields))
  summary.push(`${r.prefix} via ${r.nextHop}:`, ...describeSet(fields, route))
  return [{ path: STATIC_PATH, lines: [], typed, summary, label: `static route ${r.prefix} via ${r.nextHop}` }]
}

export function staticRemoveEditsTyped(r: StaticRoute): StagedEdit[] {
  return [
    {
      path: STATIC_PATH,
      lines: [],
      typed: [{ remove: { area: "static", prefix: r.prefix, next_hop: r.nextHop } }],
      summary: [`remove ${r.prefix} via ${r.nextHop}`],
      label: `remove route ${r.prefix} via ${r.nextHop}`,
    },
  ]
}
