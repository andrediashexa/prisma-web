// The upgrade's stream as the Upgrade card shows it (Prisma 0.153.3, #97).

import type { UpgradeProgress } from "@/lib/types"

/** A DOWNLOAD that carries the download's progress, not a line of its own (a URL, a stall, a resume). */
export function isDownloadProgress(p: Pick<UpgradeProgress, "phase" | "downloaded_bytes" | "total_bytes">): boolean {
  return p.phase === "DOWNLOAD" && ((p.downloaded_bytes ?? 0) > 0 || (p.total_bytes ?? 0) > 0)
}

/**
 * The rows after one more message. From 0.153.3 a box sends a DOWNLOAD every few seconds: only the
 * latest progress is kept, last, and every other message is a row of its own, read by its phase.
 */
export function foldUpgrade<T extends Pick<UpgradeProgress, "phase" | "downloaded_bytes" | "total_bytes">>(rows: T[], p: T): T[] {
  if (!isDownloadProgress(p)) return [...rows, p]
  return [...rows.filter((r) => !isDownloadProgress(r)), p]
}

/** Bytes as the box's line prints them: decimal, to the 0.1 MB. */
function mb(bytes: number): string {
  return (bytes / 1e6).toFixed(1)
}

/** The rate as the box's line prints it: KB/s under 1 MB/s, else to the 0.1 MB/s. */
function rate(bps: number): string {
  return bps < 1e6 ? `${Math.round(bps / 1e3)} KB/s` : `${(bps / 1e6).toFixed(1)} MB/s`
}

function left(s: number): string {
  if (s < 60) return `${s} s left`
  const m = Math.floor(s / 60)
  return s % 60 ? `${m} min ${s % 60} s left` : `${m} min left`
}

/** "14.1 of 189.0 MB, 2.3 MB/s, 1 min 16 s left"; a size or time the box could not tell is left out. */
export function downloadText(p: Pick<UpgradeProgress, "downloaded_bytes" | "total_bytes" | "bytes_per_second" | "seconds_left">): string {
  const done = p.downloaded_bytes ?? 0
  const total = p.total_bytes ?? 0
  const parts = [total ? `${mb(done)} of ${mb(total)} MB` : `${mb(done)} MB`]
  if (p.bytes_per_second) parts.push(rate(p.bytes_per_second))
  if (p.seconds_left) parts.push(left(p.seconds_left))
  return parts.join(", ")
}

/** The bar's share, 0 to 100, or null when the box did not say the size. */
export function downloadPercent(p: Pick<UpgradeProgress, "downloaded_bytes" | "total_bytes">): number | null {
  const total = p.total_bytes ?? 0
  if (!total) return null
  return Math.min(100, Math.round(((p.downloaded_bytes ?? 0) / total) * 100))
}
