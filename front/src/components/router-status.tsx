"use client"

import useSWR from "swr"

import { fetcher } from "@/lib/api"
import type { SystemInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Nome do roteador e indicador de conexão com a API do Prisma. */
export function RouterStatus() {
  const { data, error } = useSWR<SystemInfo>("/router/system", fetcher, { refreshInterval: 10_000 })
  const online = !!data && !error
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className="relative flex size-2.5">
        {online && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />}
        <span className={cn("relative inline-flex size-2.5 rounded-full", online ? "bg-emerald-500" : error ? "bg-destructive" : "bg-muted-foreground")} />
      </span>
      <span className="truncate font-medium">{data?.hostname ?? (error ? "Prisma inacessível" : "Conectando…")}</span>
      {data && <span className="text-muted-foreground hidden truncate sm:inline">{data.version}</span>}
    </div>
  )
}
