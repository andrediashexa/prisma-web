/**
 * The configuration as a structure (#39): the VTY's grammar as the back end
 * serves it (config_model.rs), and how a statement's form becomes its line.
 */

import type { WhoAmI } from "@/lib/types"

export type Kind =
  | { k: "text" }
  | { k: "int"; min: number; max: number }
  | { k: "ipv4" }
  | { k: "ipv4_prefix" }
  | { k: "ipv6" }
  | { k: "ipv6_prefix" }
  | { k: "address" }
  | { k: "prefix" }
  | { k: "interface" }

export type Tok =
  | { t: "word"; w: string }
  | { t: "param"; id: number; label: string; kind: Kind; prefix: string; rest: boolean }
  | { t: "opt"; items: Tok[] }
  | { t: "alt"; options: Tok[][] }

export interface Statement {
  syntax: string
  class: string
  tokens: Tok[]
}

export interface Mode {
  key: string
  title: string
  path: string[]
  path_tokens: Tok[][]
  roles: string[]
  groups: { title: string; statements: Statement[] }[]
}

export interface Grammar {
  source: string
  modes: Mode[]
}

export interface ConfigLine {
  text: string
  /** The box's own line, read only on purpose: why (Prisma 0.149.20). */
  owned: string | null
  /** [group, statement] in the mode; null when no statement matched. */
  statement: [number, number] | null
  values: Record<string, string>
}

export interface Instance {
  mode: string
  path: string[]
  lines: ConfigLine[]
}

/** The form's state: values by parameter id, which optional parts are on and which alternative is chosen. */
export interface FormState {
  values: Record<number, string>
  opts: Record<string, boolean>
  alts: Record<string, number>
}

export const emptyForm = (): FormState => ({ values: {}, opts: {}, alts: {} })

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

/** RFC 4291 text form: eight groups of 1-4 hex digits, one "::" at most, an IPv4 tail allowed (#40). */
export function isIpv6(v: string) {
  let s = v
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (tail) {
    if (!IPV4.test(tail[2])) return false
    s = `${tail[1]}0:0`
  }
  const halves = s.split("::")
  if (halves.length > 2) return false
  const groups = halves.flatMap((h) => (h === "" ? [] : h.split(":")))
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false
  return halves.length === 2 ? groups.length < 8 : groups.length === 8
}

export const isIpv4 = (v: string) => IPV4.test(v)

function prefix(v: string, check: (a: string) => boolean, max: number) {
  const [a, l, extra] = v.split("/")
  return extra === undefined && l !== undefined && /^\d+$/.test(l) && Number(l) <= max && check(a)
}

/** Why a value does not fit its parameter, or null. */
export function invalid(kind: Kind, v: string): string | null {
  if (!v.trim()) return "required"
  switch (kind.k) {
    case "text":
    case "interface":
      return null
    case "int":
      return /^\d+$/.test(v) && Number(v) >= kind.min && Number(v) <= kind.max ? null : `a number from ${kind.min} to ${kind.max}`
    case "ipv4":
      return IPV4.test(v) ? null : "an IPv4 address"
    case "ipv6":
      return isIpv6(v) ? null : "an IPv6 address"
    case "address":
      return IPV4.test(v) || isIpv6(v) ? null : "an IPv4 or IPv6 address"
    case "ipv4_prefix":
      return prefix(v, (a) => IPV4.test(a), 32) ? null : "an IPv4 prefix (A.B.C.D/M)"
    case "ipv6_prefix":
      return prefix(v, isIpv6, 128) ? null : "an IPv6 prefix (X:X::X:X/M)"
    case "prefix":
      return prefix(v, (a) => IPV4.test(a), 32) || prefix(v, isIpv6, 128) ? null : "an IPv4 or IPv6 prefix"
  }
}

/** The line a filled form gives, or the first problem. */
export function buildLine(tokens: Tok[], s: FormState, key = ""): { line: string } | { error: string } {
  const out: string[] = []
  for (const [i, t] of tokens.entries()) {
    const k = `${key}${i}`
    if (t.t === "word") out.push(t.w)
    else if (t.t === "param") {
      const v = (s.values[t.id] ?? "").trim()
      const why = invalid(t.kind, v)
      if (why) return { error: `${t.label}: ${why}` }
      out.push(t.prefix + v)
    } else if (t.t === "opt") {
      if (!s.opts[k]) continue
      const r = buildLine(t.items, s, `${k}.`)
      if ("error" in r) return r
      out.push(r.line)
    } else {
      const choice = s.alts[k] ?? 0
      const r = buildLine(t.options[choice], s, `${k}.${choice}.`)
      if ("error" in r) return r
      out.push(r.line)
    }
  }
  return { line: out.filter(Boolean).join(" ") }
}

/** A short text for a token list, as the syntax reads. */
export function describe(tokens: Tok[]): string {
  return tokens
    .map((t) =>
      t.t === "word" ? t.w : t.t === "param" ? `${t.prefix}<${t.label}>` : t.t === "opt" ? `[${describe(t.items)}]` : t.options.map(describe).join(" | "),
    )
    .join(" ")
}

/**
 * The form's state that reproduces a configured line: the back end gives the
 * parameter values; optional parts and alternatives are recovered by trying
 * them against the line.
 */
export function stateFor(tokens: Tok[], line: string, values: Record<string, string>): FormState {
  const s: FormState = { values: Object.fromEntries(Object.entries(values).map(([k, v]) => [Number(k), v])), opts: {}, alts: {} }
  const ids = (ts: Tok[]): number[] =>
    ts.flatMap((t) => (t.t === "param" ? [t.id] : t.t === "opt" ? ids(t.items) : t.t === "alt" ? t.options.flatMap(ids) : []))
  const walk = (ts: Tok[], key: string) => {
    for (const [i, t] of ts.entries()) {
      const k = `${key}${i}`
      if (t.t === "opt") {
        const inner = ids(t.items)
        s.opts[k] = inner.length > 0 ? inner.some((id) => s.values[id] !== undefined) : ` ${line} `.includes(` ${describe(t.items)} `)
        walk(t.items, `${k}.`)
      } else if (t.t === "alt") {
        const pick = t.options.findIndex((o) => {
          const oi = ids(o)
          return oi.length > 0 ? oi.some((id) => s.values[id] !== undefined) : o.every((w) => w.t !== "word" || ` ${line} `.includes(` ${w.w} `))
        })
        s.alts[k] = Math.max(0, pick)
        t.options.forEach((o, n) => walk(o, `${k}.${n}.`))
      }
    }
  }
  walk(tokens, "")
  return s
}

/** The leading keywords of a statement, before any value. */
export function head(tokens: Tok[]): string {
  const words: string[] = []
  for (const t of tokens) {
    if (t.t !== "word") break
    words.push(t.w)
  }
  return words.join(" ")
}

/** Whether a mode's path element is named by a value (an interface, a pool): one more can be added. */
export function isNamed(m: Mode): boolean {
  const last = m.path_tokens.at(-1)
  return !!last?.some((t) => t.t === "param" || t.t === "alt")
}

/** Whether the box account may change a mode (#28, #39): CGNAT modes are open to a cgnat-operator. */
export function boxAllows(access: WhoAmI | null, m: Pick<Mode, "roles">) {
  if (!access) return true
  return access.can_configure || (access.can_configure_cgnat && m.roles.includes("cgnat-operator"))
}
