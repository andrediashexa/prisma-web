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
