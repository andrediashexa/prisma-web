"use client"

import { createContext, useContext, useMemo } from "react"
import useSWR, { useSWRConfig } from "swr"

import { ChangeReview } from "@/components/config/change-review"
import { StagedChanges } from "@/components/config/staged-changes"
import { useClears } from "@/components/clear-action"
import { useConfigChanges } from "@/hooks/use-config-changes"
import { useFleetStatus, useRouterAccess, useRouterRole } from "@/hooks/use-routers"
import { fetcher } from "@/lib/api"
import { boxAllows, type Grammar, type Instance } from "@/lib/config-model"
import { readRouting, readRoutingTyped, toChange, type RoutingConfig, type StagedEdit } from "@/lib/routing-config"
import { useTypedConfig } from "@/lib/typed-config"
import { roleAtLeast, routerApi } from "@/lib/types"

interface RoutingState {
  routerId: string
  /** The routing configuration: typed where the box answers GetConfig, the tree otherwise; undefined while read. */
  routing: RoutingConfig | undefined
  typedError: Error | undefined
  editable: boolean
  stage: (...edits: StagedEdit[]) => void
  cc: ReturnType<typeof useConfigChanges>
  release: string | undefined
  clears: ReturnType<typeof useClears>
}

const RoutingContext = createContext<RoutingState | null>(null)

export function useRouting() {
  const v = useContext(RoutingContext)
  if (!v) throw new Error("useRouting outside the routing pages")
  return v
}

/**
 * What the routing pages share (#88): the configuration read once, and one set of staged changes
 * with its review, so a change staged on one page stays staged on another and they are applied together.
 */
export function RoutingProvider({ routerId: id, children }: { routerId: string; children: React.ReactNode }) {
  const { mutate } = useSWRConfig()
  // The routing configuration (#42, #43), read from the running configuration's tree.
  const { data: tree, mutate: mutateTree } = useSWR<{ revision: string; instances: Instance[] }>(routerApi(id, "/config/tree"), fetcher)
  const { data: grammar } = useSWR<Grammar>(routerApi(id, "/config/grammar"), fetcher, { revalidateOnFocus: false })
  // Typed on a box that answers GetConfig's routing areas (Prisma 0.149.22, #46); the tree otherwise.
  const typed = useTypedConfig(id, ["static", "bgp", "ospf", "ospf6", "interface_routing", "interfaces"])
  const routing = useMemo(
    () => (typed.config ? readRoutingTyped(typed.config) : typed.typed === false && tree ? readRouting(tree.instances) : undefined),
    [tree, typed.config, typed.typed],
  )
  const cc = useConfigChanges(id)
  const myRole = useRouterRole(id)
  const { access, readOnly } = useRouterAccess(id)
  const release = useFleetStatus().data?.find((r) => r.id === id)?.version?.release
  // The routing modes' roles come from the grammar (administrator today).
  const roles = grammar?.modes.find((m) => m.key === "router bgp <asn>")?.roles ?? ["administrator"]
  const editable = !!routing && roleAtLeast(myRole, "operator") && !readOnly && boxAllows(access, { roles })
  const clears = useClears(id)
  const value: RoutingState = {
    routerId: id,
    routing,
    typedError: typed.error,
    editable,
    stage: (...edits) => edits.forEach((e) => cc.stage(toChange(e))),
    cc,
    release,
    clears,
  }

  return (
    <RoutingContext.Provider value={value}>
      {typed.error && <p className="text-destructive text-sm">Could not read the typed configuration: {typed.error.message}</p>}
      {children}
      {/* Kept in sight while scrolling, on every routing page: the forms stage into it. */}
      <div className="sticky bottom-4 z-20 shadow-lg empty:hidden">
        <StagedChanges cc={cc} />
      </div>
      <ChangeReview
        routerId={id}
        candidateId={cc.candidateId}
        title="Apply routing changes"
        defaultComment={cc.reviewed.map((c) => c.label).join("; ")}
        onClose={cc.closeReview}
        onStale={cc.reopen}
        staged={cc.staged}
        onCommitted={() => {
          cc.committed()
          void mutateTree()
          void typed.mutate()
          void mutate(routerApi(id, "/bgp"))
        }}
      />
    </RoutingContext.Provider>
  )
}
