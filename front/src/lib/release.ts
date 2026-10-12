/** Whether a Prisma release ("0.152.11", "v0.152.11-mock") is at least `min`; unknown is not. */
export function releaseAtLeast(release: string | undefined, min: [number, number, number]): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(release?.trim() ?? "")
  if (!m) return false
  const v = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i]
  return true
}

/** `show cgnat ha peer <file>` through GetHaStatus (Prisma 0.152.11, #95). */
export const HA_PEER_PATH_FROM: [number, number, number] = [0, 152, 11]

/** A peer copy's path, or why not: empty for the default, else absolute as the box requires. */
export function peerPathError(p: string): string | null {
  const v = p.trim()
  if (!v) return null
  if (!v.startsWith("/")) return "an absolute path on the router (/var/lib/...)"
  if (new TextEncoder().encode(v).length > 4096) return "at most 4096 bytes"
  return null
}

/** A virtual router's family: 4 or 6. A box before 0.153.1 sends 0, and its routers are all IPv4 (#96). */
export function vrFamily(family: number | undefined): 4 | 6 {
  return family === 6 ? 6 : 4
}

/** The key of a virtual router: from 0.153.1 one VRRP id may be two routers, one per family (#96). */
export function vrKey(r: { interface: string; vr_id: number; family?: number }): string {
  return `${r.interface}-${r.vr_id}-${vrFamily(r.family)}`
}
