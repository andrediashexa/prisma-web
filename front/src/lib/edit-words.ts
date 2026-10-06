/**
 * `replace pattern` and `rename` (Prisma 0.151.13, #74): two lines Edit takes that change the
 * candidate as a whole. GetSchema does not list them; the form builds the line itself.
 */

/** From this release the box takes them; the grammar does not say so. */
export const EDIT_WORDS_FROM: [number, number, number] = [0, 151, 13]

export function editWordsOffered(release: string | undefined): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(release?.trim() ?? "")
  if (!m) return false
  const v = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) if (v[i] !== EDIT_WORDS_FROM[i]) return v[i] > EDIT_WORDS_FROM[i]
  return true
}

/** A value as the VTY takes one with spaces or a `|`: double-quoted, a quote inside as `\"`. */
export const quote = (v: string) => `"${v.replace(/"/g, '\\"')}"`

export interface ReplaceForm {
  pattern: string
  replacement: string
  /** At most this many substitutions; "" for every match. */
  upto: string
}

/** Why the replace form does not fit, or null. */
export function replaceError(f: ReplaceForm): string | null {
  if (!f.pattern) return "a pattern"
  if (/[\r\n]/.test(f.replacement)) return "the replacement is one line"
  if (f.upto.trim() && !/^[1-9]\d{0,8}$/.test(f.upto.trim())) return "upto: a number of substitutions, 1 or more"
  return null
}

/** The line, with `| compare` for the preview: the box answers the difference and stages nothing. */
export function replaceLine(f: ReplaceForm, compare: boolean): string {
  const upto = f.upto.trim() ? ` upto ${f.upto.trim()}` : ""
  return `replace pattern ${quote(f.pattern)} with ${quote(f.replacement)}${upto}${compare ? " | compare" : ""}`
}

/** What `rename` renames: the words before the name, as the box lists them. */
export const RENAME_KINDS = [
  { value: "cgnat-pool", label: "CGNAT pool", words: "nat cgnat pool" },
  { value: "nat64-pool", label: "NAT64 pool", words: "nat nat64 pool" },
  { value: "ip-prefix-list", label: "IPv4 prefix-list", words: "ip prefix-list" },
  { value: "ipv6-prefix-list", label: "IPv6 prefix-list", words: "ipv6 prefix-list" },
  { value: "route-map", label: "Route-map", words: "route-map" },
  { value: "peer-group", label: "BGP peer-group", words: "router bgp <AS> peer-group" },
  { value: "interface", label: "Interface", words: "interface" },
] as const
export type RenameKind = (typeof RENAME_KINDS)[number]["value"]

export interface RenameForm {
  kind: RenameKind
  name: string
  to: string
  /** The BGP instance's AS, for a peer-group. */
  asn: string
}

const oneWord = (v: string) => !!v && !/\s/.test(v)

export function renameError(f: RenameForm): string | null {
  if (!oneWord(f.name.trim())) return "the current name, one word"
  if (!oneWord(f.to.trim())) return "the new name, one word"
  if (f.to.trim() === f.name.trim()) return "a different name"
  if (f.kind === "peer-group" && !/^\d+$/.test(f.asn.trim())) return "the BGP instance's AS"
  return null
}

export function renameLine(f: RenameForm): string {
  const words = RENAME_KINDS.find((k) => k.value === f.kind)!.words.replace("<AS>", f.asn.trim())
  return `rename ${words} ${f.name.trim()} to ${f.to.trim()}`
}
