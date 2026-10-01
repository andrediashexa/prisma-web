"use client"

import { useId, useState } from "react"
import useSWR from "swr"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fetcher } from "@/lib/api"
import { formatBps, formatBpsShort } from "@/lib/format"
import { routerApi, type RouterInterface, type TrafficSeries } from "@/lib/types"

const RANGES = [
  { value: "15", label: "15 min" },
  { value: "60", label: "1 h" },
  { value: "360", label: "6 h" },
  { value: "1440", label: "24 h" },
]

const config = {
  rx: { label: "Download", color: "var(--chart-1)" },
  tx: { label: "Upload", color: "var(--chart-2)" },
} satisfies ChartConfig

export function TrafficChart({
  routerId,
  title = "Traffic",
  defaultInterface,
  defaultMinutes = 60,
}: {
  routerId: string
  title?: string
  defaultInterface?: string
  defaultMinutes?: number
}) {
  const { data: ifs } = useSWR<{ interfaces: RouterInterface[] }>(routerApi(routerId, "/interfaces"), fetcher, {
    refreshInterval: 30_000,
  })
  // Interfaces with link first: the chart's default should have traffic to show.
  const candidates = [...(ifs?.interfaces.filter((i) => i.name !== "lo") ?? [])].sort(
    (a, b) => Number(b.link_up) - Number(a.link_up),
  )
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "")
  const [iface, setIface] = useState<string | undefined>(defaultInterface)
  const [minutes, setMinutes] = useState(String(defaultMinutes))
  const selected = candidates.some((i) => i.name === iface) ? iface : candidates[0]?.name

  const { data } = useSWR<TrafficSeries>(
    selected
      ? routerApi(routerId, `/metrics/traffic?interface=${encodeURIComponent(selected)}&minutes=${minutes}`)
      : null,
    fetcher,
    { refreshInterval: 5_000, keepPreviousData: true },
  )

  const points = data?.samples.map((s) => ({ t: new Date(s.timestamp).getTime(), rx: s.rx_bps, tx: s.tx_bps })) ?? []
  const last = points.at(-1)
  const tick = (t: number) =>
    new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {last ? (
            <span className="tabular-nums">
              <span className="text-chart-1">↓ {formatBps(last.rx)}</span>
              <span className="mx-2">·</span>
              <span className="text-chart-2">↑ {formatBps(last.tx)}</span>
            </span>
          ) : (
            "Throughput per interface"
          )}
          {data && !data.live && points.length > 0 && <span className="text-destructive ml-2">· telemetry disconnected</span>}
        </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selected} onValueChange={setIface}>
            <SelectTrigger size="sm" className="w-36" aria-label="Interface">
              <SelectValue placeholder="Interface" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((i) => (
                <SelectItem key={i.name} value={i.name}>
                  {i.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Tabs value={minutes} onValueChange={setMinutes}>
            <TabsList>
              {RANGES.map((r) => (
                <TabsTrigger key={r.value} value={r.value} className="px-2 text-xs">
                  {r.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </CardHeader>
      <CardContent>
        {!data ? (
          <Skeleton className="aspect-[3/1] w-full" />
        ) : points.length < 2 ? (
          <div className="text-muted-foreground flex h-72 flex-col items-center justify-center gap-1 text-center text-sm">
            {data.live ? (
              <>
                <span>Collecting samples…</span>
                <span className="text-xs">prisma-web builds the history from Prisma&apos;s telemetry.</span>
              </>
            ) : (
              <span className="text-destructive">No telemetry from this router right now.</span>
            )}
          </div>
        ) : (
          <ChartContainer id={`traffic-${uid}`} config={config} className="aspect-auto h-72 w-full">
            <AreaChart data={points} margin={{ left: 4, right: 8 }}>
              <defs>
                {(["rx", "tx"] as const).map((k) => (
                  <linearGradient key={k} id={`fill-${k}-${uid}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={`var(--color-${k})`} stopOpacity={0.45} />
                    <stop offset="95%" stopColor={`var(--color-${k})`} stopOpacity={0.02} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={48}
                tickFormatter={tick}
              />
              <YAxis width={48} tickLine={false} axisLine={false} tickFormatter={formatBpsShort} />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    labelFormatter={(_, payload) =>
                      payload?.[0] ? new Date(payload[0].payload.t).toLocaleString("en-US") : ""
                    }
                    formatter={(value, name) => (
                      <div className="flex w-full justify-between gap-4">
                        <span className="text-muted-foreground">{config[name as keyof typeof config]?.label}</span>
                        <span className="font-mono font-medium tabular-nums">{formatBps(Number(value))}</span>
                      </div>
                    )}
                  />
                }
              />
              <Area dataKey="rx" type="monotone" fill={`url(#fill-rx-${uid})`} stroke="var(--color-rx)" strokeWidth={2} isAnimationActive={false} />
              <Area dataKey="tx" type="monotone" fill={`url(#fill-tx-${uid})`} stroke="var(--color-tx)" strokeWidth={2} isAnimationActive={false} />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
