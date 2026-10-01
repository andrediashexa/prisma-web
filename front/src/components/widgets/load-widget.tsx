"use client"

import useSWR from "swr"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher } from "@/lib/api"
import { BUSY_SATURATED, formatBytes, formatCompact, formatPercent, workerFill } from "@/lib/format"
import { routerApi, type SystemInfo, type WorkerLoad } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Under this loop rate a worker waits for interrupts instead of polling (docs/prisma-api.md). */
const INTERRUPT_LOOPS = 1_000

/** The box reports memory in numbers (Prisma 0.149.2); older ones send 0. */
export function hasMemoryNumbers(sys: SystemInfo | undefined): sys is SystemInfo & { memory_total_bytes: number } {
  return !!sys?.memory_total_bytes && sys.memory_total_bytes > 0
}

const fillClass = (pct: number) => (pct > 85 ? "bg-destructive" : pct > 65 ? "bg-chart-4" : "bg-primary")

/**
 * Memory and each dataplane worker's load (#25). A polling worker's CPU is
 * always 100%, so the load is what the dataplane counts: busy_ratio, whose
 * saturation is about 0.5 — the bar is full there and the raw ratio is shown
 * beside it. A box that does not report the numbers gets its verbatim text.
 */
export function LoadWidget({ routerId, title = "Dataplane load" }: { routerId: string; title?: string }) {
  const { data: sys } = useSWR<SystemInfo>(routerApi(routerId, "/system"), fetcher, { refreshInterval: 5_000 })
  const workers = sys?.worker_load ?? []
  const memory = hasMemoryNumbers(sys)

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>Memory and the load each dataplane worker carries</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!sys && <Skeleton className="h-40 w-full" />}
        {sys && (memory ? <MemoryBar sys={sys} /> : <Verbatim label="Memory" text={sys.memory_text} />)}
        {sys &&
          (workers.length > 0 ? (
            <div className="space-y-3">
              <div className="text-muted-foreground flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium">Workers</span>
                <span title="busy_ratio is VPP's share of node clocks; it leaves out the receive inside the input node, so a worker that cannot keep up reads about 0.5">
                  bar full at {BUSY_SATURATED} busy (saturated)
                </span>
              </div>
              {workers.map((w) => (
                <WorkerRow key={w.worker} w={w} />
              ))}
            </div>
          ) : (
            <Verbatim label="CPU" text={sys.cpu_text} />
          ))}
      </CardContent>
    </Card>
  )
}

function MemoryBar({ sys }: { sys: SystemInfo & { memory_total_bytes: number } }) {
  const total = sys.memory_total_bytes
  const used = Math.min(sys.memory_used_bytes ?? 0, total)
  const huge = Math.min(sys.memory_hugepages_bytes ?? 0, used)
  const pct = (used / total) * 100
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">Memory</span>
        <span className="tabular-nums">
          {formatBytes(used)} / {formatBytes(total)} <span className="text-muted-foreground">· {formatPercent(pct)}</span>
        </span>
      </div>
      <div
        className="bg-muted flex h-2 gap-0.5 overflow-hidden rounded-full"
        role="meter"
        aria-label="Memory used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div className="bg-chart-2 h-full transition-all duration-500" style={{ width: `${(huge / total) * 100}%` }} />
        <div className="bg-primary h-full transition-all duration-500" style={{ width: `${((used - huge) / total) * 100}%` }} />
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
        <span className="flex items-center gap-1.5">
          <span className="bg-chart-2 size-2 rounded-full" />
          Hugepages {formatBytes(huge)} ({formatPercent(used > 0 ? (huge / used) * 100 : 0)} of used)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="bg-primary size-2 rounded-full" />
          Other {formatBytes(used - huge)}
        </span>
        <span>Free {formatBytes(total - used)}</span>
      </div>
    </div>
  )
}

function WorkerRow({ w }: { w: WorkerLoad }) {
  const waiting = w.loops_per_second > 0 && w.loops_per_second < INTERRUPT_LOOPS
  const fill = workerFill(w.busy_ratio)
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs tabular-nums">
        <span>
          <span className="font-mono font-medium">vpp_wk_{w.worker}</span>
          <span className="text-muted-foreground"> · CPU {w.cpu}</span>
        </span>
        <span className="text-muted-foreground">
          <span className="text-foreground font-medium" title="busy_ratio, raw">
            {w.busy_ratio.toFixed(2)} busy
          </span>
          {" · "}
          {w.vectors_per_call.toFixed(1)} vec/call · {formatCompact(w.loops_per_second)} loops/s
        </span>
      </div>
      <div
        className="bg-muted h-1.5 overflow-hidden rounded-full"
        role="meter"
        aria-label={`Worker ${w.worker} load`}
        aria-valuemin={0}
        aria-valuemax={BUSY_SATURATED}
        aria-valuenow={w.busy_ratio}
      >
        <div className={cn("h-full rounded-full transition-all duration-500", fillClass(fill))} style={{ width: `${fill}%` }} />
      </div>
      {waiting && <p className="text-muted-foreground text-xs">Waiting for interrupts, not polling</p>}
    </div>
  )
}

function Verbatim({ label, text }: { label: string; text: string }) {
  if (!text) return null
  return (
    <div className="space-y-1.5">
      <div className="text-muted-foreground text-xs font-medium">{label}, as the box reports it</div>
      <pre className="bg-muted overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed">{text.trimEnd()}</pre>
    </div>
  )
}
