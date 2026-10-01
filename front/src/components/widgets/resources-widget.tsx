"use client"

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { useFleetStatus } from "@/hooks/use-routers"
import { formatNumber } from "@/lib/format"

const config = {
  occupancy: { label: "Ocupação da tabela de sessões", color: "var(--chart-1)" },
} satisfies ChartConfig

/** Compara a ocupação da tabela de sessões entre os roteadores online. */
export function ResourcesWidget() {
  const { data } = useFleetStatus()
  const rows =
    data
      ?.filter((r) => r.sessions && r.sessions.sessions_fit > 0)
      .map((r) => ({
        name: r.name,
        occupancy: Math.round((r.sessions!.sessions / r.sessions!.sessions_fit) * 1000) / 10,
        sessions: r.sessions!.sessions,
        fit: r.sessions!.sessions_fit,
      })) ?? []

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Sessões por roteador</CardTitle>
        <CardDescription>Ocupação da tabela de sessões do dataplane (%)</CardDescription>
      </CardHeader>
      <CardContent>
        {!data ? (
          <Skeleton className="h-56 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nenhum roteador online.</p>
        ) : (
          <ChartContainer config={config} className="aspect-auto h-56 w-full">
            <BarChart data={rows} margin={{ left: -16, right: 4 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} />
              <YAxis domain={[0, (max: number) => Math.max(10, Math.ceil(max / 10) * 10)]} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    formatter={(_, __, item) => (
                      <div className="flex w-full justify-between gap-4">
                        <span className="text-muted-foreground">{item.payload.occupancy}%</span>
                        <span className="font-mono tabular-nums">
                          {formatNumber(item.payload.sessions)} / {formatNumber(item.payload.fit)}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <Bar dataKey="occupancy" fill="var(--color-occupancy)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
