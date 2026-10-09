/**
 * Each CPU's load (Prisma 0.152.9, #87). A CPU a VPP thread polls on reads ~100% busy whatever
 * it forwards: its load is the dataplane's `busy_ratio`, full at saturation; any other CPU's is its
 * `busy_percent`. A box before 0.152.9 has only its workers' `busy_ratio` (GetHistory `workers`).
 */

/** How the CPU usage card draws its history (#87). */
export const USAGE_VIEWS = [
  { value: "lines", label: "Lines" },
  { value: "heatmap", label: "Heatmap" },
] as const
export type UsageView = (typeof USAGE_VIEWS)[number]["value"]
export const isUsageView = (v: unknown): v is UsageView => USAGE_VIEWS.some((x) => x.value === v)

export const USAGE_RANGES = [15, 60, 360, 1440] as const

export interface CpuUsage {
  cpu: number
  busy_percent: number
  steal_percent: number
  polling: boolean
  busy_ratio: number
  window_ms: number
}

export interface WorkerLoad {
  worker: number
  cpu: number
  busy_ratio: number
}

/** A CPU's load, 0 to 1. */
export function loadOf(u: Pick<CpuUsage, "polling" | "busy_percent" | "busy_ratio">, saturated: number): number {
  const v = u.polling ? u.busy_ratio / saturated : u.busy_percent / 100
  return Math.min(1, Math.max(0, v))
}

export interface Sample {
  at: string | null
  cpus?: CpuUsage[]
  workers?: WorkerLoad[]
}

/** The history as one row per minute, each CPU's load by its number; the workers' only for a box before 0.152.9. */
export function historyRows(samples: Sample[], saturated: number): { at: number; loads: Record<number, number> }[] {
  return samples
    .filter((s) => s.at)
    .map((s) => {
      const loads: Record<number, number> = {}
      if (s.cpus && s.cpus.length) for (const u of s.cpus) loads[u.cpu] = loadOf(u, saturated)
      else for (const w of s.workers ?? []) loads[w.cpu] = loadOf({ polling: true, busy_ratio: w.busy_ratio, busy_percent: 0 }, saturated)
      return { at: Date.parse(s.at as string), loads }
    })
    .sort((a, b) => a.at - b.at)
}

/** The CPUs any row names, in order. */
export const cpusOf = (rows: { loads: Record<number, number> }[]) =>
  [...new Set(rows.flatMap((r) => Object.keys(r.loads).map(Number)))].sort((a, b) => a - b)

/**
 * The rows in at most `columns` buckets of equal time, each CPU's load averaged in a bucket;
 * null where a bucket has no reading of that CPU (for a heatmap).
 */
export function buckets(rows: { at: number; loads: Record<number, number> }[], columns: number): { from: number; to: number; loads: Record<number, number | null> }[] {
  if (!rows.length) return []
  const cpus = cpusOf(rows)
  const start = rows[0].at
  const end = rows[rows.length - 1].at
  const n = Math.max(1, Math.min(columns, rows.length))
  const width = Math.max(1, (end - start) / n)
  const out = Array.from({ length: n }, (_, i) => ({ from: start + i * width, to: start + (i + 1) * width, sum: {} as Record<number, number>, count: {} as Record<number, number> }))
  for (const r of rows) {
    const i = Math.min(n - 1, Math.floor((r.at - start) / width))
    for (const [c, v] of Object.entries(r.loads)) {
      out[i].sum[+c] = (out[i].sum[+c] ?? 0) + v
      out[i].count[+c] = (out[i].count[+c] ?? 0) + 1
    }
  }
  return out.map((b) => ({ from: b.from, to: b.to, loads: Object.fromEntries(cpus.map((c) => [c, b.count[c] ? b.sum[c] / b.count[c] : null])) }))
}
