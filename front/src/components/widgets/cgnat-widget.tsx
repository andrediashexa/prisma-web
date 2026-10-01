"use client"

import { useState } from "react"
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
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fetcher } from "@/lib/api"
import { formatNumber } from "@/lib/format"
import { routerApi, type CgnatSample, type Series } from "@/lib/types"

const config = {
  sessions: { label: "Sessions", color: "var(--chart-1)" },
  subscribers: { label: "Subscribers", color: "var(--chart-3)" },
} satisfies ChartConfig

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

/** CGNAT sessions and subscribers over time (from telemetry). */
export function CgnatWidget({ routerId, title = "CGNAT" }: { routerId: string; title?: string }) {
  const [minutes, setMinutes] = useState("60")
  const { data } = useSWR<Series<CgnatSample>>(routerApi(routerId, `/metrics/cgnat?minutes=${minutes}`), fetcher, {
    refreshInterval: 5_000,
    keepPreviousData: true,
  })
  const points = data?.samples.map((s) => ({ t: new Date(s.timestamp).getTime(), ...s })) ?? []
  const last = points.at(-1)

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>{title}</CardTitle>
          <CardDescription>
            {last
              ? `${formatNumber(last.sessions)} sessions · ${formatNumber(last.subscribers)} subscribers · ${formatNumber(last.refusals)} refusals`
              : "Sessions and subscribers"}
          </CardDescription>
        </div>
        <Tabs value={minutes} onValueChange={setMinutes}>
          <TabsList>
            {[
              ["15", "15 min"],
              ["60", "1 h"],
              ["360", "6 h"],
              ["1440", "24 h"],
            ].map(([v, l]) => (
              <TabsTrigger key={v} value={v} className="px-2 text-xs">
                {l}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        {!data ? (
          <Skeleton className="h-56 w-full" />
        ) : points.length < 2 ? (
          <div className="text-muted-foreground flex h-56 items-center justify-center text-sm">
            {data.live ? "Collecting samples…" : "No telemetry from this router right now."}
          </div>
        ) : (
          <ChartContainer config={config} className="aspect-auto h-56 w-full">
            <AreaChart data={points} margin={{ left: 0, right: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickLine={false}
                axisLine={false}
                minTickGap={48}
                tickFormatter={(t) => new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
              />
              <YAxis yAxisId="s" width={60} tickLine={false} axisLine={false} tickFormatter={(v) => compact.format(v)} />
              <YAxis yAxisId="u" orientation="right" width={52} tickLine={false} axisLine={false} tickFormatter={(v) => compact.format(v)} />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    labelFormatter={(_, p) => (p?.[0] ? new Date(p[0].payload.t).toLocaleString("en-US") : "")}
                  />
                }
              />
              <Area yAxisId="s" dataKey="sessions" type="monotone" stroke="var(--color-sessions)" fill="var(--color-sessions)" fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
              <Area yAxisId="u" dataKey="subscribers" type="monotone" stroke="var(--color-subscribers)" fill="var(--color-subscribers)" fillOpacity={0.1} strokeWidth={2} isAnimationActive={false} />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
