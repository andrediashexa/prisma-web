/**
 * An interface's configuration as the Interfaces form edits it (#40), and the
 * VTY lines that turn one state into another.
 *
 * Reads come from the running configuration as a tree (`/config/tree`, #39);
 * writes are lines in `interface <name>` through a candidate. Prisma 0.149.20
 * adds typed `GetConfig` / `SetInterface` (#558 phase 2): only
 * `readInterfaces` and `interfaceChange` change then, the form stays.
 */

import { isIpv4, isIpv6, type Instance } from "@/lib/config-model"
import { MTU_MAX, MTU_MIN } from "@/lib/types"
import type { ConfigChange } from "@/hooks/use-config-changes"

export const PORT_MODE = "interface <name>"
export const BUNDLE_MODE = "interface bond<n>"
/** Box roles that may change both modes, as the grammar says (#39). */
export const INTERFACE_ROLES = ["administrator"]

export type CgnatRole = "" | "inside" | "outside"
export type Urpf = "" | "strict" | "loose" | "off"
export type LacpMode = "" | "active" | "passive"
export type LacpRate = "" | "fast" | "slow"
export type LoadBalance = "" | "l2" | "l23" | "l34"

/** The statements the form offers; "" is "not set" (the box's default). */
export interface InterfaceConfig {
  name: string
  bundle: boolean
  description: string
  mtu: string
  shutdown: boolean
  ipv4: string[]
  ipv6: string[]
  /** VRF table id, `vrf <1-4294967295>`. */
  vrf: string
  cgnat: CgnatRole
  urpf: Urpf
  suppressRa: boolean
  vlan: string
  vlanInner: string
  linuxName: string
  macAddress: string
  members: string[]
  lacpMode: LacpMode
  lacpRate: LacpRate
  loadBalance: LoadBalance
  /** Configured lines the form does not cover (OSPF, IS-IS, VRRP...): changed on the Settings page. */
  others: string[]
}

export const emptyInterface = (name: string): InterfaceConfig => ({
  name,
  bundle: name.startsWith("bond"),
  description: "",
  mtu: "",
  shutdown: false,
  ipv4: [],
  ipv6: [],
  vrf: "",
  cgnat: "",
  urpf: "",
  suppressRa: false,
  vlan: "",
  vlanInner: "",
  linuxName: "",
  macAddress: "",
  members: [],
  lacpMode: "",
  lacpRate: "",
  loadBalance: "",
  others: [],
})

export const interfacePath = (name: string) => [`interface ${name}`]

/** One line of `interface <name>` into the state; false when the form does not cover it. */
function read(c: InterfaceConfig, line: string): boolean {
  const w = line.split(/\s+/)
  const rest = (n: number) => w.slice(n).join(" ")
  switch (w[0]) {
    case "description":
      c.description = rest(1)
      return true
    case "mtu":
      c.mtu = w[1] ?? ""
      return w.length === 2
    case "shutdown":
      c.shutdown = true
      return w.length === 1
    case "ipv4":
    case "ipv6":
      if (w[1] !== "address" || w.length !== 3) return false
      ;(w[0] === "ipv4" ? c.ipv4 : c.ipv6).push(w[2])
      return true
    case "vrf":
      c.vrf = w[1] ?? ""
      return w.length === 2
    case "cgnat":
      if (w[1] !== "inside" && w[1] !== "outside") return false
      c.cgnat = w[1]
      return true
    case "urpf":
      if (!["strict", "loose", "off"].includes(w[1])) return false
      c.urpf = w[1] as Urpf
      return true
    case "vlan":
      c.vlan = w[1] ?? ""
      c.vlanInner = w[2] === "inner" ? (w[3] ?? "") : ""
      return true
    case "linux-name":
      c.linuxName = rest(1)
      return true
    case "mac-address":
      c.macAddress = w[1] ?? ""
      return true
    case "member":
      if (!c.bundle || w.length !== 2) return false
      c.members.push(w[1])
      return true
    case "lacp":
      if (w[1] === "mode" && (w[2] === "active" || w[2] === "passive")) c.lacpMode = w[2]
      else if (w[1] === "rate" && (w[2] === "fast" || w[2] === "slow")) c.lacpRate = w[2]
      else return false
      return true
    case "load-balance":
      if (!["l2", "l23", "l34"].includes(w[1])) return false
      c.loadBalance = w[1] as LoadBalance
      return true
  }
  if (line === "ipv6 nd suppress-ra") {
    c.suppressRa = true
    return true
  }
  return false
}

/** Every port and bundle of the configuration tree, as the form edits them. */
export function readInterfaces(instances: Instance[]): InterfaceConfig[] {
  return instances
    .filter((i) => i.mode === PORT_MODE || i.mode === BUNDLE_MODE)
    .map((i) => {
      const c = emptyInterface(i.path[0].replace(/^interface\s+/, ""))
      c.bundle = i.mode === BUNDLE_MODE
      for (const l of i.lines) if (!read(c, l.text)) c.others.push(l.text)
      return c
    })
}

/** `cur` set when it differs from `old`: the old line removed first, as the Settings page does. */
function swap(out: string[], old: string, cur: string, line: (v: string) => string) {
  if (old === cur) return
  if (old) out.push(`no ${line(old)}`)
  if (cur) out.push(line(cur))
}

function lists(out: string[], old: string[], cur: string[], line: (v: string) => string) {
  for (const v of old) if (!cur.includes(v)) out.push(`no ${line(v)}`)
  for (const v of cur) if (!old.includes(v)) out.push(line(v))
}

/**
 * The lines that take an interface from `old` to `cur`, removals before
 * additions so an address can be replaced. `description`, `mtu` and
 * `shutdown` keep the forms confirmed on the box (docs/prisma-integration.md 1.1).
 */
export function interfaceLines(old: InterfaceConfig, cur: InterfaceConfig): string[] {
  const out: string[] = []
  const d = cur.description.trim()
  if (d !== old.description) out.push(d ? `description ${d}` : "no description")
  if (cur.mtu !== old.mtu) out.push(cur.mtu ? `mtu ${cur.mtu}` : `no mtu ${old.mtu}`)
  if (cur.shutdown !== old.shutdown) out.push(cur.shutdown ? "shutdown" : "no shutdown")
  lists(out, old.ipv4, cur.ipv4, (a) => `ipv4 address ${a}`)
  lists(out, old.ipv6, cur.ipv6, (a) => `ipv6 address ${a}`)
  swap(out, old.vrf, cur.vrf, (v) => `vrf ${v}`)
  swap(out, old.cgnat, cur.cgnat, (v) => `cgnat ${v}`)
  swap(out, old.urpf, cur.urpf, (v) => `urpf ${v}`)
  if (cur.suppressRa !== old.suppressRa) out.push(cur.suppressRa ? "ipv6 nd suppress-ra" : "no ipv6 nd suppress-ra")
  const vlan = (c: InterfaceConfig) => (c.vlan ? `${c.vlan}${c.vlanInner ? ` inner ${c.vlanInner}` : ""}` : "")
  swap(out, vlan(old), vlan(cur), (v) => `vlan ${v}`)
  swap(out, old.linuxName, cur.linuxName.trim(), (v) => `linux-name ${v}`)
  swap(out, old.macAddress, cur.macAddress.trim().toLowerCase(), (v) => `mac-address ${v}`)
  if (cur.bundle) {
    lists(out, old.members, cur.members, (m) => `member ${m}`)
    swap(out, old.lacpMode, cur.lacpMode, (v) => `lacp mode ${v}`)
    swap(out, old.lacpRate, cur.lacpRate, (v) => `lacp rate ${v}`)
    swap(out, old.loadBalance, cur.loadBalance, (v) => `load-balance ${v}`)
  }
  return out
}

/** The staged change for one interface; staging it again replaces it. */
export function interfaceChange(old: InterfaceConfig, cur: InterfaceConfig): ConfigChange {
  return { path: interfacePath(cur.name), lines: interfaceLines(old, cur), label: `edit ${cur.name}`, key: `interface ${cur.name}` }
}

// --- Validation: what the form refuses before anything reaches the box. ---
// BigInt() rather than literals: the build targets ES2017.

/** An address as a number, its family's width and the prefix length. */
function parse(cidr: string): { n: bigint; bits: number; len: number } | null {
  const [a, l, extra] = cidr.split("/")
  if (extra !== undefined || l === undefined || !/^\d{1,3}$/.test(l)) return null
  const len = Number(l)
  if (isIpv4(a)) return len > 32 ? null : { n: a.split(".").reduce((acc, o) => (acc << BigInt(8)) | BigInt(o), BigInt(0)), bits: 32, len }
  if (!isIpv6(a)) return null
  let s = a
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (tail) {
    const v4 = tail[2].split(".").map(Number)
    s = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const [hi, lo] = s.split("::")
  const g = (h: string | undefined) => (h ? h.split(":") : [])
  const groups = lo === undefined ? g(hi) : [...g(hi), ...Array(8 - g(hi).length - g(lo).length).fill("0"), ...g(lo)]
  return len > 128 ? null : { n: groups.reduce((acc, x) => (acc << BigInt(16)) | BigInt(parseInt(x, 16)), BigInt(0)), bits: 128, len }
}

const network = (p: { n: bigint; bits: number }, len: number) => p.n >> BigInt(p.bits - len)

/** Why an address cannot be added to `family` on `iface`, or null. `all` is every interface, to catch overlaps. */
export function addressProblem(family: "ipv4" | "ipv6", cidr: string, iface: InterfaceConfig, all: InterfaceConfig[]): string | null {
  const v = cidr.trim()
  if (!v) return "type an address with its prefix length"
  const p = parse(v)
  if (!p || (family === "ipv4") !== (p.bits === 32)) {
    return family === "ipv4" ? "not an IPv4 address with a prefix length (A.B.C.D/M)" : "not an IPv6 address with a prefix length (X:X::X:X/M)"
  }
  if (p.len === 0) return "a /0 is not an interface address"
  const host = p.n & ((BigInt(1) << BigInt(p.bits - p.len)) - BigInt(1))
  if (p.bits === 32 && p.len <= 30) {
    if (host === BigInt(0)) return "this is the network address of the prefix; use a host address"
    if (host === (BigInt(1) << BigInt(32 - p.len)) - BigInt(1)) return "this is the broadcast address of the prefix"
  }
  if (p.bits === 32 && p.n >> BigInt(28) === BigInt(14)) return "a multicast address cannot be an interface address"
  if (p.bits === 128 && p.n >> BigInt(120) === BigInt(0xff)) return "a multicast address cannot be an interface address"
  for (const other of all) {
    // The same prefix in another VRF is a different network.
    const self = other.name === iface.name
    if (!self && other.vrf !== iface.vrf) continue
    for (const a of family === "ipv4" ? (self ? iface.ipv4 : other.ipv4) : self ? iface.ipv6 : other.ipv6) {
      const q = parse(a)
      if (!q) continue
      if (q.n === p.n) return self ? "already on this interface" : `already configured on ${other.name}`
      const len = Math.min(p.len, q.len)
      if (!self && network(p, len) === network(q, len)) return `overlaps ${a} on ${other.name}`
    }
  }
  return null
}

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i
const int = (v: string, min: number, max: number) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max

/** Problems with the scalar fields, by field; addresses are checked as they are added. */
export function fieldProblems(c: InterfaceConfig): Partial<Record<keyof InterfaceConfig, string>> {
  const out: Partial<Record<keyof InterfaceConfig, string>> = {}
  if (c.mtu && !int(c.mtu, MTU_MIN, MTU_MAX)) out.mtu = `a number from ${MTU_MIN} to ${MTU_MAX}`
  if (c.vrf && !int(c.vrf, 1, 4294967295)) out.vrf = "a VRF table id from 1 to 4294967295"
  if (c.vlan && !int(c.vlan, 1, 4094)) out.vlan = "a VLAN id from 1 to 4094"
  if (c.vlanInner && !int(c.vlanInner, 1, 4094)) out.vlanInner = "a VLAN id from 1 to 4094"
  if (c.vlanInner && !c.vlan) out.vlanInner = "an inner VLAN needs the outer one"
  if (c.macAddress.trim() && !MAC.test(c.macAddress.trim())) out.macAddress = "six hex pairs, e.g. 02:00:00:00:00:01"
  if (/\s/.test(c.linuxName.trim())) out.linuxName = "one word"
  return out
}
