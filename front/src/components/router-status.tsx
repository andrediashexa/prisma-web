"use client"

import { useFleetStatus } from "@/hooks/use-routers"
import { cn } from "@/lib/utils"

/** Resumo da frota no cabeçalho: quantos Prismas estão respondendo. */
export function RouterStatus() {
  const { data, error } = useFleetStatus()
  const total = data?.length ?? 0
  const online = data?.filter((r) => r.online).length ?? 0
  const color = error || (data && online < total) ? (online === 0 ? "bg-destructive" : "bg-chart-4") : data ? "bg-emerald-500" : "bg-muted-foreground"

  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className="relative flex size-2.5">
        {data && total > 0 && online === total && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
        )}
        <span className={cn("relative inline-flex size-2.5 rounded-full", color)} />
      </span>
      <span className="truncate font-medium">
        {error ? "Sem conexão com o back" : !data ? "Conectando…" : total === 0 ? "Nenhum Prisma cadastrado" : `${online} de ${total} Prismas online`}
      </span>
    </div>
  )
}
