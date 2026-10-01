"use client"

import useSWR from "swr"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher } from "@/lib/api"
import { formatNumber, formatUptime } from "@/lib/format"
import { routerApi, type BgpNeighbor } from "@/lib/types"

export function BgpStateBadge({ state }: { state: string }) {
  return state === "Established" ? (
    <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">{state}</Badge>
  ) : (
    <Badge variant="destructive">{state}</Badge>
  )
}

/** Vizinhos BGP de um roteador, com destaque para sessões que não subiram. */
export function BgpWidget({ routerId, title = "Vizinhos BGP" }: { routerId: string; title?: string }) {
  const { data } = useSWR<{ neighbors: BgpNeighbor[] }>(routerApi(routerId, "/bgp"), fetcher, { refreshInterval: 15_000 })
  const up = data?.neighbors.filter((n) => n.state === "Established").length ?? 0

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{data ? `${up} de ${data.neighbors.length} estabelecidos` : "Sessões BGP"}</CardDescription>
      </CardHeader>
      <CardContent>
        {!data && <Skeleton className="h-24 w-full" />}
        {data?.neighbors.length === 0 && <p className="text-muted-foreground text-sm">Nenhum vizinho BGP configurado.</p>}
        <ul className="divide-y">
          {data?.neighbors.map((n) => (
            <li key={`${n.vrf}-${n.peer}`} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-sm">{n.peer}</div>
                <div className="text-muted-foreground text-xs">
                  AS {n.remote_as}
                  {n.vrf !== "default" && ` · vrf ${n.vrf}`}
                  {n.state === "Established" && ` · ${formatUptime(n.uptime_seconds)} · ${formatNumber(n.prefixes_received)} prefixos`}
                </div>
              </div>
              <BgpStateBadge state={n.state} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
