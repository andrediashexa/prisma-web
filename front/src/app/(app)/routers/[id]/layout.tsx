"use client"

import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import { EyeIcon, ServerOffIcon } from "lucide-react"

import { PendingConfirmBanner } from "@/components/config/pending-confirm"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useFleetStatus, useRouterAccess, useRouters } from "@/hooks/use-routers"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const TABS = [
  { href: "", label: "Dashboard" },
  { href: "/interfaces", label: "Interfaces" },
  { href: "/config", label: "Configuration" },
  { href: "/cgnat", label: "CGNAT" },
  { href: "/routing", label: "Routing" },
  { href: "/policies", label: "Policies" },
  { href: "/console", label: "Console" },
]

export default function RouterLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>()
  const pathname = usePathname()
  const { data: routers } = useRouters()
  const { data: fleet } = useFleetStatus()
  const router = routers?.find((r) => r.id === id)
  const status = fleet?.find((r) => r.id === id)
  const { access, reason } = useRouterAccess(id)

  if (!routers) return <Skeleton className="h-96 w-full rounded-xl" />
  if (!router) {
    return (
      <div className="text-muted-foreground flex min-h-64 flex-col items-center justify-center gap-3 text-sm">
        <ServerOffIcon className="size-6" />
        Router not found. It may have been removed.
        <Button variant="outline" asChild>
          <Link href="/routers">View routers</Link>
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
                !status ? "bg-muted-foreground" : status.health === "not-serving" ? "bg-amber-500" : status.online ? "bg-emerald-500" : "bg-destructive",
              )}
            />
            <h1 className="truncate text-2xl font-semibold tracking-tight">{router.name}</h1>
          </div>
          <p className="text-muted-foreground truncate text-sm">
            {router.description ?? status?.system?.hostname ?? "Prisma"}
            <span className="mx-2">·</span>
            <span className="font-mono text-xs">{router.api_url}</span>
            {status?.version && <span className="ml-2 text-xs">· Prisma {status.version.release}</span>}
            {access && (
              <Badge variant="outline" className="ml-2 align-middle font-normal" title="The account the box sees prisma-web as (client certificate CN) and its VTY role.">
                {access.account} · {access.role}
              </Badge>
            )}
          </p>
        </div>
        <nav className="bg-muted text-muted-foreground inline-flex h-9 max-w-full items-center overflow-x-auto rounded-lg p-1">
          {TABS.map((t) => {
            const href = base + t.href
            const active = t.href === "" ? pathname === base : pathname.startsWith(href)
            return (
              <Link
                key={t.label}
                href={href}
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors",
                  active ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
                )}
              >
                {t.label}
              </Link>
            )
          })}
        </nav>
      </div>
      <PendingConfirmBanner routerId={id} />
      {reason && (
        <div className="bg-muted text-muted-foreground flex items-center gap-2 rounded-lg border px-4 py-3 text-sm">
          <EyeIcon className="size-4 shrink-0" /> {reason}
        </div>
      )}
      {status?.log_export === "not-serving" && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-4 py-3 text-sm">
          The CGNAT log export is stalled: a collector has had records to take and got nothing for a minute.{" "}
          <Link href={`${base}/cgnat`} className="font-medium underline underline-offset-4">
            See the log export
          </Link>
        </div>
      )}
      {status?.health === "not-serving" && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          The router&apos;s API answers but reports <span className="font-mono">NOT_SERVING</span>: the dataplane&apos;s statistics do not answer, so counters and telemetry may be stale or missing.
        </div>
      )}
      {status && !status.online && status.health !== "not-serving" && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-4 py-3 text-sm">
          Could not reach this router: {status.error}
        </div>
      )}
      {/* Grid, not flex: in flex, cards with overflow-hidden shrink when a widget uses h-full. */}
      <div className="grid min-w-0 gap-6">{children}</div>
    </>
  )
}
