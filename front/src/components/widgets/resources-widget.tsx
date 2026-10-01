"use client"

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

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
import { useFleetStatus } from "@/hooks/use-routers"

const config = {
  cpu: { label: "CPU", color: "var(--chart-1)" },
  mem: { label: "Memória", color: "var(--chart-2)" },
} satisfies ChartConfig

/** Compara uso de CPU e memória entre todos os roteadores online. */
export function ResourcesWidget() {
  const { data } = useFleetStatus()
  const rows =
    data
      ?.filter((r) => r.system)
      .map((r) => ({
        name: r.name,
        cpu: Math.round(r.system!.cpu_percent),
        mem: Math.round((r.system!.memory_used_bytes / r.system!.memory_total_bytes) * 100),
      })) ?? []

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Recursos por roteador</CardTitle>
        <CardDescription>Uso de CPU e memória (%)</CardDescription>
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
              <YAxis domain={[0, 100]} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
              <Bar dataKey="cpu" fill="var(--color-cpu)" radius={4} />
              <Bar dataKey="mem" fill="var(--color-mem)" radius={4} />
              <ChartLegend content={<ChartLegendContent />} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
