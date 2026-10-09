/**
 * A router's CPUs and RAM by plane (#81), from GetSystem: the `system cpu` layout this boot
 * runs (ranges like "0-1", "3-7", "2") and the RAM in bytes. The contract has no physical
 * sockets, physical cores or CPU model: nothing here guesses them.
 */

/** "0-1,4,6-7" → [0, 1, 4, 6, 7]; "" or text that is not a list → []. */
export function parseCpus(list: string | undefined | null): number[] {
  const out = new Set<number>()
  for (const part of (list ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) return []
    const [lo, hi] = [Number(m[1]), Number(m[2] ?? m[1])]
    if (hi < lo || hi - lo > 4096) return []
    for (let c = lo; c <= hi; c++) out.add(c)
  }
  return [...out].sort((a, b) => a - b)
}

export interface Plane {
  key: "control" | "main" | "workers"
  label: string
  /** What runs there. */
  hint: string
  cpus: number[]
}

export function cpuPlanes(sys: { control_plane_cpus?: string; main_thread_cpu?: string; worker_cpus?: string }): Plane[] {
  return [
    { key: "control", label: "Control plane", hint: "Linux, FRR routing, the management API and VTY", cpus: parseCpus(sys.control_plane_cpus) },
    { key: "main", label: "Dataplane main thread", hint: "VPP's main thread: control of the dataplane", cpus: parseCpus(sys.main_thread_cpu) },
    { key: "workers", label: "Dataplane workers", hint: "VPP's workers: forwarding and CGNAT, each polling its CPU", cpus: parseCpus(sys.worker_cpus) },
  ]
}

/** The CPUs the layout names, each once. */
export const layoutCpus = (planes: Plane[]) => [...new Set(planes.flatMap((p) => p.cpus))].sort((a, b) => a - b)

/** "0-1", "2", "3-7": a sorted list back as ranges. */
export function showCpus(cpus: number[]): string {
  const out: string[] = []
  for (let i = 0; i < cpus.length; ) {
    let j = i
    while (j + 1 < cpus.length && cpus[j + 1] === cpus[j] + 1) j++
    out.push(i === j ? `${cpus[i]}` : `${cpus[i]}-${cpus[j]}`)
    i = j + 1
  }
  return out.join(", ")
}

export interface MemorySplit {
  total: number
  /** Reserved for the dataplane: its 1G hugepages. */
  dataplane: number
  /** The rest of what is used: the control plane and the system. */
  control: number
  free: number
}

/** The RAM by plane; null when the box does not report it in numbers (before 0.149.2). */
export function memorySplit(sys: { memory_total_bytes?: number; memory_used_bytes?: number; memory_hugepages_bytes?: number }): MemorySplit | null {
  const total = sys.memory_total_bytes ?? 0
  if (total <= 0) return null
  const used = Math.min(sys.memory_used_bytes ?? 0, total)
  const dataplane = Math.min(sys.memory_hugepages_bytes ?? 0, used)
  return { total, dataplane, control: used - dataplane, free: total - used }
}

/** The ways the split can be shown (#85). */
export const RESOURCE_VIEWS = [
  { value: "bars", label: "Bars" },
  { value: "map", label: "Map" },
  { value: "donut", label: "Donut" },
  { value: "table", label: "Table" },
] as const
export type ResourceView = (typeof RESOURCE_VIEWS)[number]["value"]
export const isResourceView = (v: unknown): v is ResourceView => RESOURCE_VIEWS.some((x) => x.value === v)

export interface CpuTile {
  cpu: number
  /** The plane the layout gives it; null for a CPU no plane names. */
  plane: Plane["key"] | null
  /** A worker's load, 0 to 1 of saturation; null when not a worker or not reported. */
  load: number | null
}

/**
 * One tile per logical CPU from 0 to the highest the layout names (#85), with its plane and, for a
 * worker's CPU, its load: `busy_ratio` over `saturated` (the dataplane saturates near 0.5).
 */
export function cpuMap(planes: Plane[], workers: { cpu: number; busy_ratio?: number }[], saturated: number): CpuTile[] {
  const all = layoutCpus(planes)
  if (all.length === 0) return []
  const max = all[all.length - 1]
  const load = new Map(workers.map((w) => [w.cpu, Math.min(1, Math.max(0, (w.busy_ratio ?? 0) / saturated))]))
  return Array.from({ length: max + 1 }, (_, cpu) => {
    const plane = planes.find((p) => p.cpus.includes(cpu))?.key ?? null
    return { cpu, plane, load: plane === "workers" ? (load.get(cpu) ?? null) : null }
  })
}
