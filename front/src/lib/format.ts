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
