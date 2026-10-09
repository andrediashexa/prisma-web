/**
 * The lists a routing policy matches on (#89): policy-options' `prefix-list`, `community`,
 * `large-community` and `extended-community`, read as fields (GetConfig area `policy`, Prisma
 * 0.149.24) and written as lines, as the contract says of policy-options; FRR's own prefix-lists
 * and community lists (area `frr_lists`) are shown, not written.
 */

export interface NamedList {
  name: string
  members: string[]
}

export interface PolicyLists {
  prefix_lists: NamedList[]
  communities: NamedList[]
  large_communities: NamedList[]
  extended_communities: NamedList[]
  as_paths: { name: string; regex: string }[]
  /** A policy-options line the box's parser could not read, with why. */
  unread: { line: string; why: string }[]
}

export interface FrrPrefixList {
  /** "ipv4" or "ipv6". */
  family: string
  name: string
  /** 0 is not stated, for `sequence`, `ge` and `le`. */
  entries: { sequence: number; action: string; prefix: string; ge: number; le: number; description: string }[]
}

export interface BgpList {
  /** "community", "large-community", "extcommunity" or "as-path". */
  kind: string
  style: string
  name: string
  entries: { sequence: number; action: string; value: string }[]
}

export interface FrrLists {
  prefix_lists: FrrPrefixList[]
  bgp_lists: BgpList[]
}

/** The kinds a policy's `from` and `set` name, as policy-options writes them. */
export type ListKind = "prefix-list" | "community" | "large-community" | "extended-community"

export const PATH = ["policy-options"]

/**
 * The policies whose text names a list: `from <kind> <name>`, or `set <kind> add|set|delete <name>`
 * (a community), read from ListPolicies' text, so it holds on any box with policies.
 */
export function usedBy(policies: { name: string; text: string }[], kind: ListKind, name: string): string[] {
  return policies
    .filter((p) =>
      p.text.split("\n").some((l) => {
        const w = l.trim().split(/\s+/)
        // `then local-preference 200` is not a list; `then community add X` (Junos' word) is.
        const head = w[0] === "then" || w[0] === "set" ? 1 : w[0] === "from" ? 1 : -1
        if (head < 0 || w[head] !== kind) return false
        const rest = w.slice(head + 1).filter((x) => !["add", "set", "delete"].includes(x))
        return rest.includes(name)
      }),
    )
    .map((p) => p.name)
}

/** A list's name: one word the VTY takes. */
export const isListName = (s: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}$/.test(s)

function isV4(s: string) {
  const p = s.split(".")
  return p.length === 4 && p.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
}

function isV6(s: string) {
  if (!/^[0-9a-fA-F:]+$/.test(s) || !s.includes(":")) return false
  const halves = s.split("::")
  if (halves.length > 2) return false
  const groups = halves.flatMap((h) => (h === "" ? [] : h.split(":")))
  if (groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return false
  return halves.length === 2 ? groups.length < 8 : groups.length === 8
}

/** A prefix-list's member: an IPv4 or IPv6 network with its length. */
export function isPrefix(s: string) {
  const [addr, len, more] = s.split("/")
  if (more !== undefined || len === undefined || !/^\d{1,3}$/.test(len)) return false
  if (isV4(addr)) return Number(len) <= 32
  if (isV6(addr)) return Number(len) <= 128
  return false
}

const u16 = (s: string) => /^\d{1,5}$/.test(s) && Number(s) <= 65535
const u32 = (s: string) => /^\d{1,10}$/.test(s) && Number(s) <= 4294967295

/** A member of the list kind, or why it is not one. */
export function memberError(kind: ListKind, s: string): string | null {
  const v = s.trim()
  if (!v) return "a value is needed"
  switch (kind) {
    case "prefix-list":
      return isPrefix(v) ? null : "an IPv4 or IPv6 network with its length (10.0.0.0/8, 2001:db8::/32)"
    case "community": {
      const [a, b, c] = v.split(":")
      return c === undefined && b !== undefined && u16(a) && u16(b) ? null : "asn:value, each 0 to 65535 (65000:100)"
    }
    case "large-community": {
      const p = v.split(":")
      return p.length === 3 && p.every(u32) ? null : "asn:value1:value2, each 0 to 4294967295 (65000:1:100)"
    }
    case "extended-community": {
      const [t, a, b, more] = v.split(":")
      return more === undefined && (t === "rt" || t === "soo") && b !== undefined && (u32(a) || isV4(a)) && u32(b)
        ? null
        : "rt: or soo: then asn:value or address:value (rt:65000:100)"
    }
  }
}

/** The lines that make `members` the list's members: a prefix-list has its own mode, a community one line. */
export function setMembers(kind: ListKind, name: string, before: string[] | null, members: string[]): { path: string[]; lines: string[] } {
  if (kind === "prefix-list") {
    const old = before ?? []
    const gone = old.filter((m) => !members.includes(m)).map((m) => `no ${m}`)
    const added = members.filter((m) => !old.includes(m))
    if (members.length === 0) return { path: PATH, lines: [`no prefix-list ${name}`] }
    return { path: [...PATH, `prefix-list ${name}`], lines: [...gone, ...added] }
  }
  // Written whole: what the box keeps of a second `members` line is not the contract's to say.
  const lines = before ? [`no ${kind} ${name}`] : []
  if (members.length) lines.push(`${kind} ${name} members ${members.join(" ")}`)
  return { path: PATH, lines }
}

/** The lines that remove a list. */
export function removeList(kind: ListKind, name: string) {
  return { path: PATH, lines: [`no ${kind} ${name}`] }
}

/** FRR's community and large-community lists, the others (AS-path, extended) left out. */
export const communityLists = (f: FrrLists | undefined) => (f?.bgp_lists ?? []).filter((b) => b.kind === "community" || b.kind === "large-community")
