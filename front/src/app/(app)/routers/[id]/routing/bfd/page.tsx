"use client"

import { BfdConfig } from "@/components/routing/bfd-config"
import { useRouting } from "@/components/routing/routing-context"
import { BfdSessionsCard } from "@/components/screens"

export default function BfdPage() {
  const { routerId: id, editable, cc } = useRouting()
  return (
    <>
      {/* Prisma 0.150.6 (#64): the sessions; 0.150.12 (#67): the configuration as fields. */}
      <BfdSessionsCard routerId={id} />
      <BfdConfig routerId={id} editable={editable} onStage={(c) => cc.stage(c)} />
    </>
  )
}
