"use client"

import useSWR from "swr"
import { ClockIcon, CpuIcon, MemoryStickIcon, NetworkIcon, UsersIcon } from "lucide-react"

import { StatCard } from "@/components/stat-card"
import { Badge } from "@/components/ui/badge"
import { fetcher } from "@/lib/api"
import { formatBytes, formatNumber, formatPercent, formatUptime, isIpv6, isLinkLocal } from "@/lib/format"
import { restartNote } from "@/lib/start-cause"
import {
  routerApi,
  type RouterInterface,
  type SessionsSummary,
  type SystemInfo,
  type VersionInfo,
} from "@/lib/types"

import { hasMemoryNumbers } from "./load-widget"

/** The key metrics of a router; memory only when the box reports it in numbers (0.149.2). */
export function RouterStatsWidget({ routerId }: { routerId: string }) {
  const opts = { refreshInterval: 5_000 }
  const { data: sys } = useSWR<SystemInfo>(routerApi(routerId, "/system"), fetcher, opts)
  const { data: ver } = useSWR<VersionInfo>(routerApi(routerId, "/version"), fetcher, { refreshInterval: 60_000 })
  const { data: ses } = useSWR<SessionsSummary>(routerApi(routerId, "/sessions"), fetcher, opts)
  const { data: ifs } = useSWR<{ interfaces: RouterInterface[] }>(routerApi(routerId, "/interfaces"), fetcher, { refreshInterval: 10_000 })

  const physical = ifs?.interfaces.filter((i) => i.name !== "lo") ?? []
  const up = physical.filter((i) => i.link_up).length
  const v6 = physical.flatMap((i) => i.addresses).filter((a) => isIpv6(a) && !isLinkLocal(a)).length
  const sessPct = ses && ses.sessions_fit > 0 ? (ses.sessions / ses.sessions_fit) * 100 : undefined
  const memPct = hasMemoryNumbers(sys) ? ((sys.memory_used_bytes ?? 0) / sys.memory_total_bytes) * 100 : undefined

  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))]">
      <StatCard
        label="Uptime"
        icon={ClockIcon}
        loading={!sys}
        value={sys && formatUptime(sys.uptime_seconds)}
        hint={
          ver && (
            <span className="flex flex-wrap items-center gap-1.5">
              Prisma {ver.release}
              {restartNote(sys) && (
                <Badge variant={restartNote(sys)!.tone === "destructive" ? "destructive" : "outline"} title={restartNote(sys)!.long}>
                  {restartNote(sys)!.short}
                </Badge>
              )}
              {!ver.dataplane_current && (
                <Badge
                  variant="outline"
                  className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                  title="The upgrade replaced the VTY and the files, but the dataplane (VPP and the CGNAT plugin) only switches to the new version on the next reboot."
                >
                  reboot pending to finish the upgrade
                </Badge>
              )}
            </span>
          )
        }
      />
      <StatCard
        label="Dataplane"
        icon={CpuIcon}
        loading={!sys}
        value={sys && `${sys.workers} workers`}
        hint={sys && `CPUs ${sys.worker_cpus} · main ${sys.main_thread_cpu} · ${sys.hugepages} hugepages 1G`}
      />
      {hasMemoryNumbers(sys) && (
        <StatCard
          label="Memory"
          icon={MemoryStickIcon}
          value={formatBytes(sys.memory_used_bytes ?? 0)}
          percent={memPct}
          hint={`${formatPercent(memPct ?? 0)} of ${formatBytes(sys.memory_total_bytes)} · ${formatBytes(sys.memory_hugepages_bytes ?? 0)} of it hugepages`}
        />
      )}
      <StatCard
        label="CGNAT sessions"
        icon={UsersIcon}
        loading={!ses}
        value={ses && formatNumber(ses.sessions)}
        percent={sessPct}
        hint={ses && `${formatNumber(ses.subscribers)} subscribers · ${sessPct?.toFixed(1) ?? "?"}% of table`}
      />
      <StatCard
        label="Interfaces with link"
        icon={NetworkIcon}
        loading={!ifs}
        value={ifs && `${up} / ${physical.length}`}
        hint={ifs && `${v6} global IPv6 prefixes`}
      />
    </div>
  )
}
