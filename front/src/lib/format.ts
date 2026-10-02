const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })

export function formatBytes(bytes: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
  let i = 0
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024
    i++
  }
  return `${nf.format(bytes)} ${units[i]}`
}

/** Rate in bits per second, base 1000 as in network equipment. */
export function formatBps(bps: number) {
  const units = ["bps", "kbps", "Mbps", "Gbps", "Tbps"]
  let i = 0
  while (bps >= 1000 && i < units.length - 1) {
    bps /= 1000
    i++
  }
  return `${nf.format(bps)} ${units[i]}`
}

/** Short form for chart axes: 750M, 1.2G. */
export function formatBpsShort(bps: number) {
  const units = ["", "k", "M", "G", "T"]
  let i = 0
  while (bps >= 1000 && i < units.length - 1) {
    bps /= 1000
    i++
  }
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: bps < 10 ? 1 : 0 }).format(bps)}${units[i]}`
}

export function formatUptime(seconds: number) {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}min`
  if (h > 0) return `${h}h ${m}min`
  return `${m}min`
}

/** Time elapsed since an ISO instant, as an uptime ("3d 2h 4min"). */
export function formatSince(iso: string) {
  return formatUptime(Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000))
}

export function formatNumber(n: number) {
  return new Intl.NumberFormat("en-US").format(n)
}

const dtf = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "medium" })

export function formatDateTime(iso: string) {
  return dtf.format(new Date(iso))
}

const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" })

export function formatRelative(iso: string) {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 60) return rtf.format(Math.round(diff), "second")
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute")
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour")
  return rtf.format(Math.round(diff / 86400), "day")
}

export function isIpv6(cidr: string) {
  return cidr.includes(":")
}

export function isLinkLocal(cidr: string) {
  return cidr.toLowerCase().startsWith("fe80:")
}

/**
 * VPP's "unknown" link speed (u32 max in kbps) as Prisma 0.149.2 passes it on.
 * It and 0 both mean the box does not know the speed.
 */
export const UNKNOWN_SPEED_BPS = 4_294_967_295_000

/** The link speed in bits/s, or null when the box does not know it. */
export function knownSpeed(speedBps: number | undefined | null): number | null {
  if (!speedBps || speedBps <= 0 || speedBps >= UNKNOWN_SPEED_BPS) return null
  return speedBps
}

/** Link speed as a port is labelled: 10 Gb/s, 2.5 Gb/s, 100 Mb/s. */
export function formatLinkSpeed(bps: number) {
  const units = ["b/s", "kb/s", "Mb/s", "Gb/s", "Tb/s"]
  let i = 0
  while (bps >= 1000 && i < units.length - 1) {
    bps /= 1000
    i++
  }
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(bps)} ${units[i]}`
}

/**
 * Link utilization in percent: the busier direction over the link speed.
 * null when the speed is unknown — an unknown speed MUST NOT produce a percentage.
 */
export function linkUtilization(rxBps: number, txBps: number, speedBps: number | undefined | null): number | null {
  const speed = knownSpeed(speedBps)
  if (speed === null) return null
  return (Math.max(rxBps, txBps) / speed) * 100
}

export function formatPercent(pct: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: pct < 10 ? 1 : 0 }).format(pct)}%`
}

/**
 * busy_ratio of a saturated worker. VPP's share of node clocks leaves out the
 * receive inside the input node, so a worker that cannot keep up reads about
 * 0.5, not 1 (docs/prisma-api.md, "A worker's load").
 */
export const BUSY_SATURATED = 0.5

/** How full a worker is, 0–100, with BUSY_SATURATED as full. */
export function workerFill(busyRatio: number) {
  return Math.min(100, Math.max(0, (busyRatio / BUSY_SATURATED) * 100))
}

/** Compact count: 38.2k, 6.7M. */
export function formatCompact(n: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)
}

/**
 * Per-second rate of a counter between two readings; null when there is no
 * previous reading or the counter went down (a reset, e.g. a carrier change),
 * never a negative rate.
 */
export function counterRate(prev: number | undefined, cur: number, seconds: number): number | null {
  if (prev === undefined || seconds <= 0 || cur < prev) return null
  return (cur - prev) / seconds
}
