"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher } from "@/lib/api"
import { buckets, cpusOf, historyRows, loadOf, USAGE_RANGES, USAGE_VIEWS, type CpuUsage, type Sample, type UsageView } from "@/lib/cpu-usage"
import { BUSY_SATURATED, formatDateTime, formatPercent } from "@/lib/format"
import { cpuPlanes } from "@/lib/resources"
import { routerApi, type SystemInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

const RANGE_LABEL: Record<number, string> = { 15: "15 min", 60: "1 h", 360: "6 h", 1440: "24 h" }

type Plane = "control" | "main" | "worker" | "none"
const PLANE_LABEL: Record<Plane, string> = { control: "control plane", main: "main thread", worker: "worker", none: "no plane" }
const PLANE_TONE: Record<Plane, string> = { control: "bg-chart-2", main: "bg-chart-4", worker: "bg-primary", none: "bg-muted-foreground/40" }
/** Lines per plane, in shades of its colour. */
const PLANE_STROKE: Record<Plane, string[]> = {
  control: ["var(--chart-2)", "color-mix(in oklch, var(--chart-2) 60%, var(--foreground))"],
  main: ["var(--chart-4)"],
  worker: ["var(--primary)", "color-mix(in oklch, var(--primary) 70%, var(--foreground))", "color-mix(in oklch, var(--primary) 55%, var(--background))"],
  none: ["var(--muted-foreground)"],
}

type System = SystemInfo

/** Each CPU's plane: the topology's word (0.152.9), else the `system cpu` layout. */
function planeOf(sys: System | undefined): (cpu: number) => Plane {
  const fromTopology = new Map((sys?.cpu_topology?.cpus ?? []).map((c) => [c.cpu, c.plane]))
  const layout = sys ? cpuPlanes(sys) : []
  return (cpu) => {
    const word = fromTopology.get(cpu)
    if (word) return word === "control-plane" ? "control" : word === "main" ? "main" : word === "worker" ? "worker" : "none"
    const p = layout.find((x) => x.cpus.includes(cpu))?.key
    return p === "control" ? "control" : p === "main" ? "main" : p === "workers" ? "worker" : "none"
  }
}

const pct = (v: number) => formatPercent(v * 100)
const time = (ms: number, minutes: number) =>
  new Date(ms).toLocaleTimeString("en-US", minutes > 360 ? { hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" })

/** Now: one tile per CPU, its load and what the figure is. */
function NowStrip({ usage, plane }: { usage: CpuUsage[]; plane: (cpu: number) => Plane }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-2" data-cpu-now>
      {usage.map((u) => {
        const p = plane(u.cpu)
        // The main thread polls only on a box with no workers, and has no busy ratio there.
        const load = u.polling && p !== "worker" ? null : loadOf(u, BUSY_SATURATED)
        return (
          <div
            key={u.cpu}
            data-cpu={u.cpu}
            data-cpu-plane={p}
            className="rounded-lg border p-2 text-xs"
            title={u.polling ? `CPU ${u.cpu}: a VPP thread polls here (${formatPercent(u.busy_percent)} busy to the system); its load is the dataplane's busy ratio, ${u.busy_ratio}` : `CPU ${u.cpu}: ${formatPercent(u.busy_percent)} busy`}
          >
            <div className="flex items-baseline justify-between gap-1">
              <span className="font-mono font-medium">CPU {u.cpu}</span>
              <span className="tabular-nums" data-cpu-load>
                {load === null ? "polls" : pct(load)}
              </span>
            </div>
            <div className="bg-muted mt-1 h-1.5 overflow-hidden rounded-full">
              {load !== null && (
                <div className={cn("h-full rounded-full", load > 0.9 ? "bg-destructive" : load > 0.7 ? "bg-chart-4" : PLANE_TONE[p])} style={{ width: `${load * 100}%` }} />
              )}
            </div>
            <div className="text-muted-foreground mt-1 truncate">
              {PLANE_LABEL[p]}
              {u.polling && p === "worker" ? " · VPP load" : ""}
            </div>
            {u.steal_percent > 0 && <div className="text-amber-700 dark:text-amber-300">steal {formatPercent(u.steal_percent)}</div>}
          </div>
        )
      })}
    </div>
  )
}

function LinesView({ rows, cpus, plane, minutes }: { rows: ReturnType<typeof historyRows>; cpus: number[]; plane: (c: number) => Plane; minutes: number }) {
  const data = rows.map((r) => ({ at: r.at, ...Object.fromEntries(Object.entries(r.loads).map(([c, v]) => [`c${c}`, Math.round(v * 1000) / 10])) }))
  const seen: Record<Plane, number> = { control: 0, main: 0, worker: 0, none: 0 }
  const stroke = Object.fromEntries(
    cpus.map((c) => {
      const p = plane(c)
      const shades = PLANE_STROKE[p]
      return [c, shades[seen[p]++ % shades.length]]
    }),
  )
  return (
    <div className="h-64" data-cpu-lines>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ left: -16, right: 8, top: 4 }}>
          <CartesianGrid vertical={false} strokeOpacity={0.3} />
          <XAxis dataKey="at" type="number" domain={["dataMin", "dataMax"]} scale="time" tickFormatter={(v) => time(v, minutes)} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} />
          <Tooltip
            labelFormatter={(v) => formatDateTime(new Date(Number(v)).toISOString())}
            formatter={(v, name) => [`${v}%`, `CPU ${String(name).slice(1)} (${PLANE_LABEL[plane(Number(String(name).slice(1)))]})`]}
          />
          {cpus.map((c) => (
            <Line key={c} dataKey={`c${c}`} name={`c${c}`} stroke={stroke[c]} dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function HeatmapView({ rows, cpus, plane, minutes }: { rows: ReturnType<typeof historyRows>; cpus: number[]; plane: (c: number) => Plane; minutes: number }) {
  const cols = buckets(rows, 60)
  return (
    <div className="space-y-1" data-cpu-heatmap>
      {cpus.map((c) => (
        <div key={c} className="flex items-center gap-2" data-heat-cpu={c}>
          <span className="text-muted-foreground w-24 shrink-0 truncate font-mono text-xs" title={PLANE_LABEL[plane(c)]}>
            CPU {c} <span className={cn("inline-block size-2 rounded-sm align-middle", PLANE_TONE[plane(c)])} />
          </span>
          <div className="flex h-4 min-w-0 flex-1 gap-px">
            {cols.map((b, i) => {
              const v = b.loads[c]
              return (
                <div
                  key={i}
                  className={cn("h-full flex-1 rounded-[2px]", v === null && "bg-muted")}
                  style={v === null ? undefined : { background: `color-mix(in oklch, ${v > 0.9 ? "var(--destructive)" : "var(--primary)"} ${Math.round(12 + v * 88)}%, transparent)` }}
                  title={`CPU ${c} · ${time(b.from, minutes)}–${time(b.to, minutes)} · ${v === null ? "no reading" : pct(v)}`}
                />
              )
            })}
          </div>
        </div>
      ))}
      {cols.length > 0 && (
        <div className="text-muted-foreground flex justify-between pl-26 text-xs tabular-nums">
          <span>{time(cols[0].from, minutes)}</span>
          <span>{time(cols[cols.length - 1].to, minutes)}</span>
        </div>
      )}
    </div>
  )
}

/**
 * Each CPU's load now and over time (Prisma 0.152.9, #87): a polling worker's from the dataplane's
 * busy ratio, any other CPU's from the system's busy share. The box samples once a minute and
 * keeps a day; a box before 0.152.9 has only its workers.
 */
export function CpuUsageWidget({
  routerId,
  title = "CPU usage",
  view: initialView,
  minutes: initialMinutes,
}: {
  routerId: string
  title?: string
  view?: UsageView
  minutes?: number
}) {
  const [view, setView] = useState<UsageView>(initialView ?? "lines")
  const [minutes, setMinutes] = useState<number>(initialMinutes ?? 60)
  const { data: sys } = useSWR<System>(routerApi(routerId, "/system"), fetcher, { refreshInterval: 30_000 })
  const { data: hist, error } = useSWR<{ samples: Sample[] }>(routerApi(routerId, `/cpu-history?minutes=${minutes}`), fetcher, { refreshInterval: 60_000 })
  const plane = planeOf(sys)
  const rows = useMemo(() => historyRows(hist?.samples ?? [], BUSY_SATURATED), [hist])
  const cpus = cpusOf(rows)
  const usage = sys?.cpu_usage ?? []
  const reports = !!sys?.cpu_topology
  const workersOnly = !reports && rows.length > 0

  return (
    <Card className="h-full" data-cpu-usage data-view={view}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>Each core&apos;s load: a polling worker&apos;s from the dataplane, the others from the system</CardDescription>
        <CardAction className="flex flex-wrap justify-end gap-1">
          <div role="radiogroup" aria-label="View" className="bg-muted inline-flex rounded-lg p-0.5">
            {USAGE_VIEWS.map((v) => (
              <button
                key={v.value}
                type="button"
                role="radio"
                aria-checked={view === v.value}
                onClick={() => setView(v.value)}
                className={cn("rounded-md px-2 py-0.5 text-xs font-medium", view === v.value ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="Range" className="bg-muted inline-flex rounded-lg p-0.5">
            {USAGE_RANGES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={minutes === m}
                onClick={() => setMinutes(m)}
                className={cn("rounded-md px-2 py-0.5 text-xs font-medium", minutes === m ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {RANGE_LABEL[m]}
              </button>
            ))}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-5">
        {!sys && <Skeleton className="h-24 w-full" />}
        {sys && reports && usage.length === 0 && (
          <p className="text-muted-foreground text-sm" data-cpu-waiting>
            The router measures its CPUs once a minute: the first reading comes a minute after its API starts.
          </p>
        )}
        {usage.length > 0 && (
          <section className="space-y-2">
            <div className="text-muted-foreground flex flex-wrap justify-between gap-2 text-xs">
              <span>Now, over the router&apos;s last minute</span>
              {sys?.cpu_usage_at && <span>measured {formatDateTime(sys.cpu_usage_at)}</span>}
            </div>
            <NowStrip usage={usage} plane={plane} />
          </section>
        )}
        {sys && !reports && (
          <p className="text-muted-foreground text-xs" data-cpu-not-reported>
            This router reports no per-CPU usage (it comes with Prisma 0.152.9){workersOnly ? ": the history below is its dataplane workers' load only." : "."}
          </p>
        )}
        {error && <p className="text-destructive text-sm">{error instanceof Error ? error.message : "The router's history could not be read"}</p>}
        {!hist && !error && <Skeleton className="h-48 w-full" />}
        {hist && rows.length === 0 && <p className="text-muted-foreground text-sm">No reading in this range yet.</p>}
        {rows.length > 0 && view === "lines" && <LinesView rows={rows} cpus={cpus} plane={plane} minutes={minutes} />}
        {rows.length > 0 && view === "heatmap" && <HeatmapView rows={rows} cpus={cpus} plane={plane} minutes={minutes} />}
        <p className="text-muted-foreground text-xs">
          A worker&apos;s load is full at the dataplane&apos;s saturation ({BUSY_SATURATED} busy); its CPU reads ~100% to the system whatever it
          forwards, as a polling thread does.
        </p>
      </CardContent>
    </Card>
  )
}
