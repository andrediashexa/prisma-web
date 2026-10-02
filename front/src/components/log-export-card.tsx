"use client"

import { useState } from "react"
import useSWR from "swr"
import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ApiError, fetcher } from "@/lib/api"
import { counterRate, formatBytes, formatDateTime, formatNumber } from "@/lib/format"
import { routerApi, type LoggingState, type LogStream } from "@/lib/types"
import { cn } from "@/lib/utils"

const STREAM_LABEL: Record<LogStream["kind"], string> = {
  syslog: "Syslog (TCP)",
  "ipfix-tcp": "IPFIX over TCP",
  "ipfix-udp": "IPFIX over UDP",
}

/**
 * The CGNAT log export (GetLogging, Prisma 0.149.15, #34): who carries each
 * stream, whether it is delivering, and what it dropped. Hidden on a box that
 * predates it.
 */
export function LogExportCard({ routerId }: { routerId: string }) {
  // The reading before the current one, for records per second; a counter that goes down is a reset.
  const [prev, setPrev] = useState<LoggingState | null>(null)
  const [last, setLast] = useState<LoggingState | null>(null)
  const { data, error } = useSWR<LoggingState>(routerApi(routerId, "/logging"), fetcher, {
    refreshInterval: 10_000,
    onSuccess: (d) => {
      if (d.at !== last?.at) {
        setPrev(last)
        setLast(d)
      }
    },
  })

  if (error instanceof ApiError && error.status === 501) return null
  if (!data && !error) return <Skeleton className="h-40 w-full rounded-xl" />

  const rates: Record<string, number | null> = {}
  if (data && prev?.at && data.at) {
    const seconds = (Date.parse(data.at) - Date.parse(prev.at)) / 1000
    for (const s of data.streams) {
      rates[s.kind] = counterRate(prev.streams.find((p) => p.kind === s.kind)?.records, s.records, seconds)
    }
  }

  const configured = data?.streams.filter((s) => s.configured) ?? []
  const stalled = configured.filter((s) => !s.delivering)

  return (
    <Card className="py-0">
      <CardHeader className="pt-6">
        <CardTitle className="flex flex-wrap items-center gap-2">
          Log export
          {data &&
            (configured.length === 0 ? (
              <Badge variant="outline">not configured</Badge>
            ) : stalled.length > 0 ? (
              <Badge variant="destructive">{stalled.length} stalled</Badge>
            ) : (
              <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300">
                delivering
              </Badge>
            ))}
        </CardTitle>
        <CardDescription>
          {error
            ? `Could not read the log export: ${error.message}`
            : data && configured.length > 0
              ? data.carrier === "log-container" && data.logger_pid
                ? `TCP streams carried by the log container (pid ${data.logger_pid})`
                : "TCP streams carried by the dataplane"
              : "CGNAT logs to syslog and IPFIX collectors, as show cgnat logging reports them"}
        </CardDescription>
      </CardHeader>
      {data && (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Stream</TableHead>
                  <TableHead>Collector</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Records</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Backlog</TableHead>
                  <TableHead className="pr-6 text-right">Dropped</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.streams.map((s) => (
                  <StreamRow key={s.kind} stream={s} rate={rates[s.kind] ?? null} />
                ))}
              </TableBody>
            </Table>
          </div>
          {configured.length > 0 && (
            <CardContent className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 pt-4 pb-2 text-xs">
              <span>Export ring dropped {formatNumber(data.export_ring_dropped)}</span>
              <span>Worker queues dropped {formatNumber(data.worker_queue_dropped)}</span>
              <span title="Expected under exhaustion: one record a subscriber every 10 s. Not a loss.">
                Exhaustion repeats not reported {formatNumber(data.exhaustion_repeats_not_reported)}
              </span>
              {data.transmit_interface && (
                <span title="Every sender on that interface, forwarded traffic included.">
                  Transmit failures on {data.transmit_interface} {formatNumber(data.transmit_failed)}
                </span>
              )}
              {!data.rings_shared && <span className="text-amber-700 dark:text-amber-300">Event rings fell back to the dataplane&apos;s heap</span>}
            </CardContent>
          )}
          <CardContent className="pb-6">
            <h3 className="mt-2 mb-2 text-sm font-medium">Recent events</h3>
            {data.events.length === 0 ? (
              <p className="text-muted-foreground text-sm">No log export events since prisma-web connected to this router.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.events.slice(0, 10).map((e, i) => (
                  <li key={`${e.at}-${i}`} className="flex flex-wrap gap-x-2">
                    <span className="text-muted-foreground tabular-nums">{formatDateTime(e.at)}</span>
                    <Badge variant={e.kind === "log-stalled" || e.kind === "log-spill-full" ? "destructive" : "outline"} className="font-mono">
                      {e.kind}
                    </Badge>
                    <span>{e.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </>
      )}
    </Card>
  )
}

function StreamRow({ stream: s, rate }: { stream: LogStream; rate: number | null }) {
  if (!s.configured) {
    return (
      <TableRow>
        <TableCell className="pl-6 font-medium">{STREAM_LABEL[s.kind]}</TableCell>
        <TableCell colSpan={6} className="text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CircleDashedIcon className="size-4" /> not configured
          </span>
        </TableCell>
      </TableRow>
    )
  }
  const tcp = s.kind !== "ipfix-udp"
  const backlog = s.pending_bytes + s.spill_bytes
  const spillPct = s.spill_cap_bytes > 0 ? (s.spill_bytes / s.spill_cap_bytes) * 100 : 0
  return (
    <TableRow className={cn(!s.delivering && "bg-destructive/5")}>
      <TableCell className="pl-6">
        <div className="font-medium">{STREAM_LABEL[s.kind]}</div>
        <div className="text-muted-foreground text-xs" title={s.carrier_reason || undefined}>
          by the {s.carrier === "log-container" ? "log container" : "dataplane"}
          {s.carrier_reason && ` (${s.carrier_reason})`}
        </div>
      </TableCell>
      <TableCell>
        <span className="font-mono text-xs">{s.collector}</span>
        {s.source && <div className="text-muted-foreground font-mono text-xs">from {s.source}</div>}
      </TableCell>
      <TableCell>
        {s.delivering ? (
          <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
            <CircleCheckIcon className="size-4" /> delivering{tcp && s.connection && ` · ${s.connection}`}
          </span>
        ) : (
          <span className="text-destructive inline-flex items-start gap-1.5" title={s.stalled_reason}>
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <span>
              stalled{tcp && s.connection && ` · ${s.connection}`}
              <span className="block text-xs">{s.stalled_reason}</span>
            </span>
          </span>
        )}
        {s.last_progress && <div className="text-muted-foreground text-xs">last progress {formatDateTime(s.last_progress)}</div>}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatNumber(s.records)}
        <div className="text-muted-foreground text-xs">{rate === null ? "—" : `${formatNumber(Math.round(rate))}/s`}</div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {tcp ? formatBytes(s.bytes_sent) : s.packets_sent > 0 ? `${formatNumber(s.packets_sent)} pkts` : "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {tcp ? (
          <>
            {formatBytes(backlog)}
            {s.spill_bytes > 0 && (
              <div className={cn("text-xs", spillPct > 80 ? "text-destructive" : "text-muted-foreground")}>
                spill {spillPct.toFixed(0)}% of {formatBytes(s.spill_cap_bytes)}
              </div>
            )}
          </>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="pr-6 text-right tabular-nums">
        {formatNumber(s.dropped)}
        {(s.dropped_over_cap > 0 || s.send_failures > 0) && (
          <div className="text-muted-foreground text-xs">
            {s.dropped_over_cap > 0 && `${formatBytes(s.dropped_over_cap)} over the cap`}
            {s.send_failures > 0 && ` ${formatNumber(s.send_failures)} send failures`}
          </div>
        )}
      </TableCell>
    </TableRow>
  )
}
