"use client"

import { useRouting } from "@/components/routing/routing-context"
import { StaticRoutesPanel } from "@/components/routing/static-routes"
import { Skeleton } from "@/components/ui/skeleton"

export default function StaticRoutesPage() {
  const { routing, editable, stage } = useRouting()
  return (
    <>
      {routing ? (
        <StaticRoutesPanel routes={routing.statics} interfaces={routing.interfaces} editable={editable} stage={stage} typed={!!routing.typed} />
      ) : (
        <Skeleton className="h-48 w-full" />
      )}
    </>
  )
}
