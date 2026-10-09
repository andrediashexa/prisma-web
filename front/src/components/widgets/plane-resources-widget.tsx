"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts"

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/api"
import { BUSY_SATURATED, formatBytes, formatPercent } from "@/lib/format"
import {
  cpuMap,
  cpuPlanes,
  isResourceView,
  layoutCpus,
  memorySplit,
  RESOURCE_VIEWS,
  showCpus,
  type MemorySplit,
  type Plane,
  type ResourceView,
} from "@/lib/resources"
import { routerApi, type SystemInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

const CPU_TONE = { control: "bg-chart-2", main: "bg-chart-4", workers: "bg-primary" } as const
const CPU_FILL = { control: "var(--chart-2)", main: "var(--chart-4)", workers: "var(--primary)" } as const
const MEM_PARTS = [
  { key: "dataplane", label: "Dataplane", hint: "Its 1G hugepages, reserved at boot: buffers, sessions, the heap", tone: "bg-primary", fill: "var(--primary)" },
  { key: "control", label: "Control plane and system", hint: "The rest of what is used: Linux, FRR, the management", tone: "bg-chart-2", fill: "var(--chart-2)" },
  { key: "free", label: "Free", hint: "Available to Linux", tone: "bg-muted-foreground/30", fill: "var(--muted-foreground)" },
] as const

/** The router page remembers the last view in this browser (#85). */
const VIEW_KEY = "prisma-web:resources-view"

function storedView(): ResourceView | null {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return isResourceView(v) ? v : null
  } catch {
    return null
  }
}

/** One segmented bar: each part's share of the whole. */
function Bar({ label, parts }: { label: string; parts: { key: string; value: number; tone: string; title: string }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0)
  return (
    <div className="bg-muted flex h-2.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={label}>
      {total > 0 &&
        parts
          .filter((p) => p.value > 0)
          .map((p) => <div key={p.key} className={cn("h-full", p.tone)} style={{ width: `${(p.value / total) * 100}%` }} title={p.title} />)}
    </div>
  )
}

function Row({ tone, label, hint, value, detail }: { tone: string; label: string; hint: string; value: string; detail: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className={cn("mt-1.5 size-2.5 shrink-0 rounded-sm", tone)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="font-medium">{label}</span>
          <span className="tabular-nums">{value}</span>
        </div>
        <div className="text-muted-foreground flex flex-wrap justify-between gap-x-3 text-xs">
          <span>{hint}</span>
          <span className="font-mono tabular-nums">{detail}</span>
        </div>
      </div>
    </div>
  )
}

const memValue = (m: MemorySplit, key: (typeof MEM_PARTS)[number]["key"]) => m[key]

function BarsView({ planes, total, mem }: { planes: Plane[]; total: number; mem: MemorySplit | null }) {
  return (
    <>
      <section className="space-y-3" data-resources-cpu>
        <Bar label="CPUs by plane" parts={planes.map((p) => ({ key: p.key, value: p.cpus.length, tone: CPU_TONE[p.key], title: `${p.label}: ${p.cpus.length}` }))} />
        {planes.map((p) => (
          <div key={p.key} data-plane={p.key}>
            <Row
              tone={CPU_TONE[p.key]}
              label={p.label}
              hint={p.hint}
              value={`${p.cpus.length} ${p.cpus.length === 1 ? "CPU" : "CPUs"} · ${formatPercent((p.cpus.length / total) * 100)}`}
              detail={p.cpus.length ? `CPU ${showCpus(p.cpus)}` : "none"}
            />
          </div>
        ))}
      </section>
      {mem && (
        <section className="space-y-3" data-resources-memory>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Memory</h3>
            <span className="text-sm tabular-nums">{formatBytes(mem.total)} of RAM</span>
          </div>
          <Bar label="RAM by plane" parts={MEM_PARTS.map((p) => ({ key: p.key, value: memValue(mem, p.key), tone: p.tone, title: `${p.label}: ${formatBytes(memValue(mem, p.key))}` }))} />
          {MEM_PARTS.map((p) => (
            <div key={p.key} data-plane={`${p.key}-memory`}>
              <Row tone={p.tone} label={p.label} hint={p.hint} value={formatBytes(memValue(mem, p.key))} detail={formatPercent((memValue(mem, p.key) / mem.total) * 100)} />
            </div>
          ))}
        </section>
      )}
    </>
  )
}

/** One tile per logical CPU in its plane's colour; a worker's tile fills to its load. */
function MapView({ planes, sys }: { planes: Plane[]; sys: SystemInfo }) {
  const tiles = cpuMap(planes, sys.worker_load ?? [], BUSY_SATURATED)
  const label = (k: Plane["key"] | null) => planes.find((p) => p.key === k)?.label ?? "No plane"
  return (
    <section className="space-y-3" data-resources-map>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2">
        {tiles.map((t) => (
          <div
            key={t.cpu}
            data-cpu={t.cpu}
            data-cpu-plane={t.plane ?? "none"}
            className={cn("relative overflow-hidden rounded-lg border p-2 text-xs", !t.plane && "border-dashed opacity-60")}
            title={`CPU ${t.cpu}: ${label(t.plane)}${t.load !== null ? ` · load ${formatPercent(t.load * 100)} of saturation` : ""}`}
          >
            {t.plane && <div className={cn("absolute inset-x-0 top-0 h-1", CPU_TONE[t.plane])} />}
            {t.load !== null && <div className="bg-primary/15 absolute inset-x-0 bottom-0" style={{ height: `${t.load * 100}%` }} />}
            <div className="relative font-mono font-medium">CPU {t.cpu}</div>
            <div className="text-muted-foreground relative truncate">{t.plane === "workers" ? "worker" : t.plane === "main" ? "main" : t.plane === "control" ? "control" : "unused"}</div>
            {t.load !== null && <div className="relative tabular-nums">{formatPercent(t.load * 100)}</div>}
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">A worker&apos;s tile fills to its load, full at saturation ({BUSY_SATURATED} busy).</p>
    </section>
  )
}

function Donut({ label, data }: { label: string; data: { name: string; value: number; fill: string; text: string }[] }) {
  const shown = data.filter((d) => d.value > 0)
  return (
    <figure className="space-y-2" aria-label={label}>
      <figcaption className="text-sm font-medium">{label}</figcaption>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={shown} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="90%" paddingAngle={2} isAnimationActive={false}>
              {shown.map((d) => (
                <Cell key={d.name} fill={d.fill} />
              ))}
            </Pie>
            <Tooltip formatter={(_v, _n, item) => (item?.payload as { text: string } | undefined)?.text ?? ""} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="space-y-1 text-xs">
        {data.map((d) => (
          <li key={d.name} className="flex justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: d.fill }} />
              {d.name}
            </span>
            <span className="tabular-nums">{d.text}</span>
          </li>
        ))}
      </ul>
    </figure>
  )
}

function DonutView({ planes, total, mem }: { planes: Plane[]; total: number; mem: MemorySplit | null }) {
  return (
    <section className="grid grid-cols-1 gap-6 sm:grid-cols-2" data-resources-donut>
      <Donut
        label="CPUs by plane"
        data={planes.map((p) => ({ name: p.label, value: p.cpus.length, fill: CPU_FILL[p.key], text: `${p.cpus.length} · ${formatPercent((p.cpus.length / total) * 100)}` }))}
      />
      {mem && (
        <Donut
          label="RAM by plane"
          data={MEM_PARTS.map((p) => ({ name: p.label, value: memValue(mem, p.key), fill: p.fill, text: `${formatBytes(memValue(mem, p.key))} · ${formatPercent((memValue(mem, p.key) / mem.total) * 100)}` }))}
        />
      )}
    </section>
  )
}

function TableView({ planes, total, mem }: { planes: Plane[]; total: number; mem: MemorySplit | null }) {
  return (
    <section className="space-y-4" data-resources-table>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Plane</TableHead>
            <TableHead className="text-right">CPUs</TableHead>
            <TableHead>Which</TableHead>
            <TableHead className="text-right">Share</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {planes.map((p) => (
            <TableRow key={p.key} data-plane={p.key}>
              <TableCell className="font-medium">{p.label}</TableCell>
              <TableCell className="text-right tabular-nums">{p.cpus.length}</TableCell>
              <TableCell className="font-mono text-xs">{p.cpus.length ? showCpus(p.cpus) : "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{formatPercent((p.cpus.length / total) * 100)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {mem && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Memory</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {MEM_PARTS.map((p) => (
              <TableRow key={p.key}>
                <TableCell className="font-medium">{p.label}</TableCell>
                <TableCell className="text-right tabular-nums">{formatBytes(memValue(mem, p.key))}</TableCell>
                <TableCell className="text-right tabular-nums">{formatPercent((memValue(mem, p.key) / mem.total) * 100)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}

function Verbatim({ title, text }: { title: string; text?: string }) {
  if (!text?.trim()) return null
  return (
    <details className="text-sm">
      <summary className="text-muted-foreground cursor-pointer text-xs">{title}</summary>
      <pre className="bg-muted/50 mt-2 overflow-x-auto rounded-md border p-2 font-mono text-xs">{text.trimEnd()}</pre>
    </details>
  )
}

/**
 * The router's CPUs and RAM, and what each plane has of them (#81): the control plane (Linux,
 * FRR, the management), the dataplane's main thread and its workers. Four views of it (#85):
 * bars, a CPU map with each worker's load, donuts and a table. On the router page the last view
 * is remembered in the browser; a dashboard widget passes its own (`view`).
 */
export function PlaneResourcesWidget({ routerId, title = "Resources", view: initial }: { routerId: string; title?: string; view?: ResourceView }) {
  const { data: sys } = useSWR<SystemInfo>(routerApi(routerId, "/system"), fetcher, { refreshInterval: 30_000 })
  const [view, setView] = useState<ResourceView>(initial ?? "bars")
  // The router page (no view given) takes the one remembered, once on the client.
  useEffect(() => {
    if (initial) return
    const v = storedView()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (v) setView(v)
  }, [initial])
  const choose = (v: ResourceView) => {
    setView(v)
    if (!initial) {
      try {
        localStorage.setItem(VIEW_KEY, v)
      } catch {
        // A browser without storage still switches.
      }
    }
  }
  const planes = sys ? cpuPlanes(sys) : []
  const total = layoutCpus(planes).length
  const mem = sys ? memorySplit(sys) : null

  return (
    <Card className="h-full" data-resources data-view={view}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>The router&apos;s CPUs and RAM, and what each plane has of them this boot</CardDescription>
        <CardAction>
          <div role="radiogroup" aria-label="View" className="bg-muted inline-flex flex-wrap rounded-lg p-0.5">
            {RESOURCE_VIEWS.map((v) => (
              <button
                key={v.value}
                type="button"
                role="radio"
                aria-checked={view === v.value}
                onClick={() => choose(v.value)}
                className={cn("rounded-md px-2 py-0.5 text-xs font-medium", view === v.value ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {v.label}
              </button>
            ))}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-6">
        {!sys && <Skeleton className="h-40 w-full" />}
        {sys && (
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Processors</h3>
            <span className="text-sm tabular-nums" data-cpu-total>
              {total > 0 ? `${total} logical CPUs in use` : "layout not reported"}
            </span>
          </div>
        )}
        {sys && total > 0 && view === "bars" && <BarsView planes={planes} total={total} mem={mem} />}
        {sys && total > 0 && view === "map" && <MapView planes={planes} sys={sys} />}
        {sys && total > 0 && view === "donut" && <DonutView planes={planes} total={total} mem={mem} />}
        {sys && total > 0 && view === "table" && <TableView planes={planes} total={total} mem={mem} />}
        {sys && (
          <p className="text-muted-foreground text-xs" data-not-reported>
            Physical processors (sockets), physical cores against threads and the CPU model are not reported by the router; the counts are the
            logical CPUs its layout gives each plane.
          </p>
        )}
        {sys && (
          <div className="space-y-2 border-t pt-3">
            <Verbatim title="The router's CPU layout (show system cpu)" text={sys.cpu_text} />
            <Verbatim title="The router's memory (show system memory)" text={sys.memory_text} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
