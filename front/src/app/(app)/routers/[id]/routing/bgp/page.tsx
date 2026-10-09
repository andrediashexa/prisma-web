"use client"

import useSWR from "swr"

import { ClearAction } from "@/components/clear-action"
import { BgpPanel } from "@/components/routing/bgp-config"
import { useRouting } from "@/components/routing/routing-context"
import { fetcher } from "@/lib/api"
import { routerApi, type BgpNeighbor } from "@/lib/types"

export default function BgpPage() {
  const { routerId: id, routing, editable, stage, release, clears } = useRouting()
  const { data: bgp, mutate: mutateBgp } = useSWR<{ neighbors: BgpNeighbor[] }>(routerApi(id, "/bgp"), fetcher, { refreshInterval: 15_000 })
  return (
    <>
      <BgpPanel
        bgp={routing ? routing.bgp : undefined}
        live={bgp?.neighbors}
        editable={editable}
        stage={stage}
        release={release}
        clearOf={
          clears
            ? (peer) => (
                <ClearAction
                  routerId={id}
                  target="bgp"
                  name={peer}
                  title={`the BGP session with ${peer}`}
                  disrupts="A soft clear asks for or resends the routes and keeps the session up; a hard clear drops the session and its routes until it comes back."
                  onDone={() => mutateBgp()}
                />
              )
            : undefined
        }
      />
    </>
  )
}
