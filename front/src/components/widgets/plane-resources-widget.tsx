"use client"

import useSWR from "swr"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher } from "@/lib/api"
import { formatBytes, formatPercent } from "@/lib/format"
import { cpuPlanes, layoutCpus, memorySplit, showCpus } from "@/lib/resources"
import { routerApi, type SystemInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

const CPU_TONE = { control: "bg-chart-2", main: "bg-chart-4", workers: "bg-primary" } as const

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
 * FRR, the management), the dataplane's main thread and its workers. From GetSystem's layout of
 * this boot; the box does not report physical sockets, physical cores or the CPU model, and this
 * card says so rather than guess.
 */
export function PlaneResourcesWidget({ routerId }: { routerId: string }) {
  const { data: sys } = useSWR<SystemInfo>(routerApi(routerId, "/system"), fetcher, { refreshInterval: 30_000 })
  const planes = sys ? cpuPlanes(sys) : []
  const cpus = layoutCpus(planes)
  const mem = sys ? memorySplit(sys) : null

  return (
    <Card data-resources>
      <CardHeader>
        <CardTitle>Resources</CardTitle>
        <CardDescription>The router&apos;s CPUs and RAM, and what each plane has of them this boot</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!sys && <Skeleton className="h-40 w-full" />}
        {sys && (
          <section className="space-y-3" data-resources-cpu>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium">Processors</h3>
              <span className="text-sm tabular-nums" data-cpu-total>
                {cpus.length > 0 ? `${cpus.length} logical CPUs in use` : "layout not reported"}
              </span>
            </div>
            {cpus.length > 0 && (
              <>
                <Bar
                  label="CPUs by plane"
                  parts={planes.map((p) => ({ key: p.key, value: p.cpus.length, tone: CPU_TONE[p.key], title: `${p.label}: ${p.cpus.length}` }))}
                />
                {planes.map((p) => (
                  <div key={p.key} data-plane={p.key}>
                    <Row
                      tone={CPU_TONE[p.key]}
                      label={p.label}
                      hint={p.hint}
                      value={`${p.cpus.length} ${p.cpus.length === 1 ? "CPU" : "CPUs"} · ${formatPercent((p.cpus.length / cpus.length) * 100)}`}
                      detail={p.cpus.length ? `CPU ${showCpus(p.cpus)}` : "none"}
                    />
                  </div>
                ))}
              </>
            )}
            <p className="text-muted-foreground text-xs" data-not-reported>
              Physical processors (sockets), physical cores against threads and the CPU model are not reported by the router; the counts
              above are the logical CPUs its layout gives each plane.
            </p>
          </section>
        )}
        {sys && mem && (
          <section className="space-y-3" data-resources-memory>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium">Memory</h3>
              <span className="text-sm tabular-nums">{formatBytes(mem.total)} of RAM</span>
            </div>
            <Bar
              label="RAM by plane"
              parts={[
                { key: "dataplane", value: mem.dataplane, tone: "bg-primary", title: `Dataplane: ${formatBytes(mem.dataplane)}` },
                { key: "control", value: mem.control, tone: "bg-chart-2", title: `Control plane and system: ${formatBytes(mem.control)}` },
                { key: "free", value: mem.free, tone: "bg-muted-foreground/30", title: `Free: ${formatBytes(mem.free)}` },
              ]}
            />
            <div data-plane="dataplane-memory">
              <Row
                tone="bg-primary"
                label="Dataplane"
                hint="Its 1G hugepages, reserved at boot: buffers, sessions, the heap"
                value={formatBytes(mem.dataplane)}
                detail={formatPercent((mem.dataplane / mem.total) * 100)}
              />
            </div>
            <div data-plane="control-memory">
              <Row
                tone="bg-chart-2"
                label="Control plane and system"
                hint="The rest of what is used: Linux, FRR, the management"
                value={formatBytes(mem.control)}
                detail={formatPercent((mem.control / mem.total) * 100)}
              />
            </div>
            <Row tone="bg-muted-foreground/30" label="Free" hint="Available to Linux" value={formatBytes(mem.free)} detail={formatPercent((mem.free / mem.total) * 100)} />
          </section>
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
