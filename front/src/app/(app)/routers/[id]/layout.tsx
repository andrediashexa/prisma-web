"use client"

import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import { ServerOffIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useFleetStatus, useRouters } from "@/hooks/use-routers"
import { cn } from "@/lib/utils"

const TABS = [
  { href: "", label: "Painel" },
  { href: "/interfaces", label: "Interfaces" },
  { href: "/routes", label: "Rotas" },
]

export default function RouterLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>()
  const pathname = usePathname()
  const { data: routers } = useRouters()
  const { data: fleet } = useFleetStatus()
  const router = routers?.find((r) => r.id === id)
  const status = fleet?.find((r) => r.id === id)

  if (!routers) return <Skeleton className="h-96 w-full rounded-xl" />
  if (!router) {
    return (
      <div className="text-muted-foreground flex min-h-64 flex-col items-center justify-center gap-3 text-sm">
        <ServerOffIcon className="size-6" />
        Roteador não encontrado. Ele pode ter sido removido.
        <Button variant="outline" asChild>
          <Link href="/routers">Ver roteadores</Link>
        </Button>
      </div>
    )
  }

  const base = `/routers/${id}`
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "size-2.5 shrink-0 rounded-full",
                !status ? "bg-muted-foreground" : status.online ? "bg-emerald-500" : "bg-destructive",
              )}
            />
            <h1 className="truncate text-2xl font-semibold tracking-tight">{router.name}</h1>
          </div>
          <p className="text-muted-foreground truncate text-sm">
            {router.description ?? status?.system?.hostname ?? "Prisma"}
            <span className="mx-2">·</span>
            <span className="font-mono text-xs">{router.api_url}</span>
            {status?.system && <span className="ml-2 text-xs">· {status.system.version}</span>}
          </p>
        </div>
        <nav className="bg-muted text-muted-foreground inline-flex h-9 items-center rounded-lg p-1">
          {TABS.map((t) => {
            const href = base + t.href
            const active = t.href === "" ? pathname === base : pathname.startsWith(href)
            return (
              <Link
                key={t.label}
                href={href}
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                  active ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
                )}
              >
                {t.label}
              </Link>
            )
          })}
        </nav>
      </div>
      {status && !status.online && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-4 py-3 text-sm">
          Não foi possível falar com este Prisma: {status.error}
        </div>
      )}
      {children}
    </>
  )
}
