"use client"

import { useParams } from "next/navigation"

import { RoutingProvider } from "@/components/routing/routing-context"
import { ROUTING_PAGES } from "@/components/routing/routing-pages"
import { SubNav } from "@/components/sub-nav"

/** The routing pages (#88): one per protocol and the routing table, sharing one set of staged changes. */
export default function RoutingLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>()
  return (
    <RoutingProvider routerId={id}>
      <SubNav label="Routing" base={`/routers/${id}/routing`} pages={ROUTING_PAGES} />
      {children}
    </RoutingProvider>
  )
}
