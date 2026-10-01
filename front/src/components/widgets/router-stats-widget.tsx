"use client"

import useSWR from "swr"
import { ClockIcon, CpuIcon, MemoryStickIcon, NetworkIcon } from "lucide-react"

import { StatCard } from "@/components/stat-card"
import { Badge } from "@/components/ui/badge"
import { fetcher } from "@/lib/api"
import { formatBytes, formatUptime, isIpv6, isLinkLocal } from "@/lib/format"
import { routerApi, type RouterInterface, type SystemInfo } from "@/lib/types"

/** Os quatro indicadores principais de um roteador. */
export function RouterStatsWidget({ routerId }: { routerId: string }) {
  const { data: sys } = useSWR<SystemInfo>(routerApi(routerId, "/system"), fetcher, { refreshInterval: 5_000 })
  const { data: ifaces } = useSWR<RouterInterface[]>(routerApi(routerId, "/interfaces"), fetcher, { refreshInterval: 10_000 })

  const physical = ifaces?.filter((i) => i.kind !== "loopback") ?? []
  const up = physical.filter((i) => i.oper_state === "up").length
  const memPct = sys ? (sys.memory_used_bytes / sys.memory_total_bytes) * 100 : 0
  const v6Count = physical.flatMap((i) => i.addresses).filter((a) => isIpv6(a) && !isLinkLocal(a)).length

  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))]">
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
            <span className="flex flex-wrap gap-1.5">
              <Badge variant={sys.ipv4_forwarding ? "secondary" : "outline"}>IPv4 {sys.ipv4_forwarding ? "on" : "off"}</Badge>
              <Badge variant={sys.ipv6_forwarding ? "secondary" : "outline"}>IPv6 {sys.ipv6_forwarding ? "on" : "off"}</Badge>
              <span className="self-center">{v6Count} prefixos v6</span>
            </span>
          )
        }
      />
    </div>
  )
}
