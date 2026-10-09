"use client"

import Link from "next/link"
import { useParams, usePathname } from "next/navigation"

import { RoutingProvider } from "@/components/routing/routing-context"
import { ROUTING_PAGES } from "@/components/routing/routing-pages"
import { cn } from "@/lib/utils"

/** The routing pages (#88): one per protocol and the routing table, sharing one set of staged changes. */
export default function RoutingLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>()
  const pathname = usePathname()
  const base = `/routers/${id}/routing`
  return (
    <RoutingProvider routerId={id}>
      <nav aria-label="Routing" className="flex flex-wrap gap-1 border-b pb-2">
        {ROUTING_PAGES.map((p) => {
          const href = base + p.href
          const active = pathname === href
          return (
            <Link
              key={p.label}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-md px-2.5 py-1 text-sm font-medium whitespace-nowrap transition-colors",
                active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              {p.label}
            </Link>
          )
        })}
      </nav>
      {children}
    </RoutingProvider>
  )
}
