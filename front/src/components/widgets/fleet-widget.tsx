"use client"

import Link from "next/link"
import { ServerIcon, ServerOffIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useFleetStatus } from "@/hooks/use-routers"
import { formatNumber, formatUptime } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Todos os roteadores cadastrados, com estado e recursos. */
export function FleetWidget() {
  const { data } = useFleetStatus()
  const online = data?.filter((r) => r.online).length ?? 0

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Roteadores</CardTitle>
        <CardDescription>
          {data ? `${online} de ${data.length} online` : "Consultando os roteadores…"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!data && <Skeleton className="h-28 w-full" />}
        {data?.length === 0 && (
          <p className="text-muted-foreground text-sm">
            Nenhum roteador cadastrado. <Link href="/routers" className="text-primary underline-offset-4 hover:underline">Cadastrar</Link>
          </p>
        )}
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
          {data?.map((r) => {
            const s = r.system
            const ses = r.sessions
            const occ = ses && ses.sessions_fit > 0 ? (ses.sessions / ses.sessions_fit) * 100 : 0
            return (
              <Link
                key={r.id}
                href={`/routers/${r.id}`}
                className={cn(
                  "group hover:border-primary/50 hover:bg-accent/40 rounded-lg border p-3 transition-colors",
                  !r.online && "border-destructive/40 bg-destructive/5",
                )}
              >
                <div className="flex items-center gap-2">
                  {r.online ? (
                    <ServerIcon className="text-primary size-4" />
                  ) : (
                    <ServerOffIcon className="text-destructive size-4" />
                  )}
                  <span className="truncate font-medium">{r.name}</span>
                  <Badge
                    variant="outline"
                    className={cn("ml-auto", r.online ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : "border-destructive/40 text-destructive")}
                  >
                    {r.busy ? "ocupado (console)" : r.online ? `${r.latency_ms} ms` : "offline"}
                  </Badge>
                </div>
                {s ? (
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <Metric label="Sessões" value={ses ? formatNumber(ses.sessions) : "—"} pct={occ} />
                    <div>
                      <div className="text-muted-foreground">Assinantes</div>
                      <div className="font-medium tabular-nums">{ses ? formatNumber(ses.subscribers) : "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Ligado</div>
                      <div className="font-medium tabular-nums">{formatUptime(s.uptime_seconds)}</div>
                    </div>
                    {r.version && (
                      <div className="text-muted-foreground col-span-3 truncate">
                        Prisma {r.version.release}
                        {!r.version.dataplane_current && (
                          <span className="text-amber-600 dark:text-amber-400" title="O upgrade trocou o VTY e os arquivos, mas o dataplane (VPP e o plugin de CGNAT) só passa para a versão nova no próximo reboot.">
                            {" "}· reboot pendente
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-destructive mt-3 line-clamp-2 text-xs">{r.error}</p>
                )}
              </Link>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function Metric({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
      <div className="bg-muted mt-1 h-1 overflow-hidden rounded-full">
        <div
          className={cn("h-full rounded-full", pct > 85 ? "bg-destructive" : pct > 65 ? "bg-chart-4" : "bg-primary")}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  )
}
