"use client"

import { useState } from "react"
import useSWR from "swr"

import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fetcher } from "@/lib/api"
import type { RouterRoute } from "@/lib/types"

type Filter = "all" | "ipv4" | "ipv6"

export default function RoutesPage() {
  const { data } = useSWR<RouterRoute[]>("/router/routes", fetcher, { refreshInterval: 15_000 })
  const [filter, setFilter] = useState<Filter>("all")
  const rows = data?.filter((r) => filter === "all" || r.family === filter) ?? []
  const count = (f: Filter) => data?.filter((r) => f === "all" || r.family === f).length ?? 0

  return (
    <>
      <PageHeader title="Rotas" description="Tabela de roteamento IPv4 e IPv6">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList>
            <TabsTrigger value="all">Todas ({count("all")})</TabsTrigger>
            <TabsTrigger value="ipv4">IPv4 ({count("ipv4")})</TabsTrigger>
            <TabsTrigger value="ipv6">IPv6 ({count("ipv6")})</TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>
      <Card className="py-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Destino</TableHead>
                <TableHead>Gateway</TableHead>
                <TableHead>Interface</TableHead>
                <TableHead className="text-right">Métrica</TableHead>
                <TableHead>Origem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data && (
                <TableRow>
                  <TableCell colSpan={5} className="pl-4">
                    <Skeleton className="h-40 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r, idx) => {
                const isDefault = r.destination === "0.0.0.0/0" || r.destination === "::/0"
                return (
                  <TableRow key={`${r.destination}-${r.interface}-${idx}`}>
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={r.family === "ipv6" ? "border-chart-2/40 text-chart-2 font-mono text-[10px]" : "font-mono text-[10px]"}
                        >
                          {r.family === "ipv6" ? "v6" : "v4"}
                        </Badge>
                        <span className="font-mono text-sm">{r.destination}</span>
                        {isDefault && <Badge variant="secondary">padrão</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {r.gateway ?? <span className="text-muted-foreground">conectada</span>}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{r.interface}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{r.metric}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.protocol}</Badge>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </Card>
    </>
  )
}
