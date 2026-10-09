"use client"

import useSWR from "swr"

import { ClearAction } from "@/components/clear-action"
import { OspfPanel } from "@/components/routing/ospf-config"
import { useRouting } from "@/components/routing/routing-context"
import { Section } from "@/components/routing/section"
import { OspfInterfacesCard } from "@/components/screens"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/api"
import { routerApi, type OspfNeighbor } from "@/lib/types"

export default function OspfPage() {
  const { routerId: id, routing, editable, stage, clears } = useRouting()
  const { data: ospf } = useSWR<{ neighbors: OspfNeighbor[] }>(routerApi(id, "/ospf"), fetcher, { refreshInterval: 15_000 })
  return (
    <>
      <Section
        title="OSPF / OSPFv3 neighbors"
        loading={!ospf}
        empty={ospf?.neighbors.length === 0}
        action={
          clears && (
            <ClearAction
              routerId={id}
              target="ospf_process"
              title="the OSPF process"
              label="Restart OSPF"
              disrupts="Every OSPF adjacency is torn down and the process starts again; OSPF routes are withdrawn until the adjacencies are full again."
            />
          )
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Router ID</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Interface</TableHead>
              <TableHead className={clears ? undefined : "pr-6"}>State</TableHead>
              {clears && <TableHead className="pr-6" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {ospf?.neighbors.map((n) => (
              <TableRow key={`${n.protocol}-${n.router_id}-${n.interface}`}>
                <TableCell className="pl-6 font-mono text-sm">
                  {n.router_id}
                  <Badge variant="outline" className="ml-2 text-[10px]">
                    {n.protocol === "ospf6" ? "v3" : "v2"}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{n.address}</TableCell>
                <TableCell className="font-mono text-sm">{n.interface}</TableCell>
                <TableCell className={clears ? undefined : "pr-6"}>{n.state}</TableCell>
                {clears && (
                  <TableCell className="pr-6 text-right">
                    {n.protocol === "ospf" && (
                      <ClearAction
                        routerId={id}
                        target="ospf_neighbor"
                        name={n.router_id}
                        title={`the OSPF neighbor ${n.router_id}`}
                        disrupts="The adjacency is torn down and formed again; the routes through it are withdrawn meanwhile."
                      />
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
      {routing && <OspfPanel ospf={routing.ospf} ospf6={routing.ospf6} editable={editable} stage={stage} />}
      {/* Prisma 0.150.6 (#64). */}
      <OspfInterfacesCard routerId={id} />
    </>
  )
}
