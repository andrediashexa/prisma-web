"use client"

import Link from "next/link"
import useSWR from "swr"
import { ActivityIcon, ArrowRightIcon, ClockIcon, CpuIcon, MemoryStickIcon, NetworkIcon } from "lucide-react"

import { AddressList } from "@/components/address-list"
import { AuditActionBadge } from "@/components/audit-action"
import { InterfaceIcon } from "@/components/interface-icon"
import { PageHeader } from "@/components/page-header"
import { StatCard } from "@/components/stat-card"
import { TrafficChart } from "@/components/traffic-chart"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useMe } from "@/hooks/use-me"
import { fetcher } from "@/lib/api"
import { formatBytes, formatRelative, formatUptime } from "@/lib/format"
import { hasRole, type AuditPage, type RouterInterface, type SystemInfo } from "@/lib/types"

export default function DashboardPage() {
  const { data: me } = useMe()
  const { data: sys } = useSWR<SystemInfo>("/router/system", fetcher, { refreshInterval: 5_000 })
  const { data: ifaces } = useSWR<RouterInterface[]>("/router/interfaces", fetcher, { refreshInterval: 10_000 })
  const canAudit = hasRole(me, "operator")
  const { data: audit } = useSWR<AuditPage>(canAudit ? "/audit?limit=6" : null, fetcher, { refreshInterval: 15_000 })

  const physical = ifaces?.filter((i) => i.kind !== "loopback") ?? []
  const up = physical.filter((i) => i.oper_state === "up").length
  const memPct = sys ? (sys.memory_used_bytes / sys.memory_total_bytes) * 100 : 0
  const v6Count = physical.flatMap((i) => i.addresses).filter((a) => a.includes(":") && !a.startsWith("fe80")).length

  return (
    <>
      <PageHeader title="Painel" description="Visão geral do roteador em tempo real" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Tempo ligado"
          icon={ClockIcon}
          loading={!sys}
          value={sys && formatUptime(sys.uptime_seconds)}
          hint={sys && `Carga ${sys.load_average.map((l) => l.toFixed(2)).join(" · ")}`}
        />
        <StatCard
          label="CPU"
          icon={CpuIcon}
          loading={!sys}
          value={sys && `${sys.cpu_percent.toFixed(1)}%`}
          percent={sys?.cpu_percent}
          hint={sys && `${sys.cpu_cores} núcleos`}
        />
        <StatCard
          label="Memória"
          icon={MemoryStickIcon}
          loading={!sys}
          value={sys && `${memPct.toFixed(0)}%`}
          percent={memPct}
          hint={sys && `${formatBytes(sys.memory_used_bytes)} de ${formatBytes(sys.memory_total_bytes)}`}
        />
        <StatCard
          label="Interfaces ativas"
          icon={NetworkIcon}
          loading={!ifaces}
          value={ifaces && `${up} / ${physical.length}`}
          hint={
            sys && (
              <span className="flex gap-1.5">
                <Badge variant={sys.ipv4_forwarding ? "secondary" : "outline"}>IPv4 {sys.ipv4_forwarding ? "on" : "off"}</Badge>
                <Badge variant={sys.ipv6_forwarding ? "secondary" : "outline"}>IPv6 {sys.ipv6_forwarding ? "on" : "off"}</Badge>
                <span className="self-center">{v6Count} prefixos v6</span>
              </span>
            )
          }
        />
      </div>

      {ifaces ? <TrafficChart interfaces={ifaces} /> : <Skeleton className="h-96 w-full rounded-xl" />}

      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Interfaces</CardTitle>
            <CardDescription>Estado e endereçamento dual-stack</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/interfaces">
                  Gerenciar <ArrowRightIcon />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="divide-y">
            {!ifaces && <Skeleton className="h-40 w-full" />}
            {physical.map((i) => (
              <div key={i.name} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
                  <InterfaceIcon kind={i.kind} className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium">{i.name}</span>
                    <span className="text-muted-foreground truncate text-xs">{i.description}</span>
                  </div>
                  <div className="mt-1">
                    <AddressList addresses={i.addresses} hideLinkLocal />
                  </div>
                </div>
                <Badge variant={i.oper_state === "up" ? "default" : "outline"} className={i.oper_state === "up" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : ""}>
                  {i.oper_state === "up" ? "ativa" : "inativa"}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Atividade recente</CardTitle>
            <CardDescription>Últimas mudanças e acessos</CardDescription>
            {canAudit && (
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
            {!canAudit ? (
              <p className="text-muted-foreground text-sm">Disponível para operadores e administradores.</p>
            ) : !audit ? (
              <Skeleton className="h-40 w-full" />
            ) : audit.items.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nenhum evento ainda.</p>
            ) : (
              <ol className="space-y-3">
                {audit.items.map((e) => (
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
      </div>
    </>
  )
}
