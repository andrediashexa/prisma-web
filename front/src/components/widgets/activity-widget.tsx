"use client"

import Link from "next/link"
import useSWR from "swr"
import { ActivityIcon, ArrowRightIcon } from "lucide-react"

import { AuditActionBadge } from "@/components/audit-action"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useMe } from "@/hooks/use-me"
import { fetcher } from "@/lib/api"
import { formatRelative } from "@/lib/format"
import { hasRole, type AuditPage } from "@/lib/types"

/** Últimos eventos do log; filtrado por roteador quando `routerId` é dado. */
export function ActivityWidget({ routerId }: { routerId?: string }) {
  const { data: me } = useMe()
  const allowed = hasRole(me, "operator")
  const query = new URLSearchParams({ limit: "8" })
  if (routerId) query.set("router_id", routerId)
  const { data } = useSWR<AuditPage>(allowed ? `/audit?${query}` : null, fetcher, { refreshInterval: 15_000 })

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Atividade recente</CardTitle>
        <CardDescription>Últimas mudanças e acessos</CardDescription>
        {allowed && (
          <CardAction>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/audit">
                Ver tudo <ArrowRightIcon />
              </Link>
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {!allowed ? (
          <p className="text-muted-foreground text-sm">Disponível para operadores e administradores.</p>
        ) : !data ? (
          <Skeleton className="h-40 w-full" />
        ) : data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nenhum evento ainda.</p>
        ) : (
          <ol className="space-y-3">
            {data.items.map((e) => (
              <li key={e.id} className="flex items-start gap-3">
                <ActivityIcon className={`mt-0.5 size-4 shrink-0 ${e.success ? "text-muted-foreground" : "text-destructive"}`} />
                <div className="min-w-0 flex-1 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{e.username ?? "—"}</span>
                    <AuditActionBadge action={e.action} success={e.success} />
                    {e.target && <span className="text-muted-foreground font-mono text-xs">{e.target}</span>}
                  </div>
                  <div className="text-muted-foreground text-xs">{formatRelative(e.at)}</div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
