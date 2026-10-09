"use client"

import { useRouting } from "@/components/routing/routing-context"
import { RoutingLoggingCard } from "@/components/screens"

export default function RoutingLoggingPage() {
  const { routerId: id } = useRouting()
  return (
    <>
      {/* Prisma 0.150.6 (#64): FRR's logging. */}
      <RoutingLoggingCard routerId={id} />
    </>
  )
}
