"use client"

import useSWR from "swr"

import { ClearAction } from "@/components/clear-action"
import { useRouting } from "@/components/routing/routing-context"
import { Section } from "@/components/routing/section"
import { IsisInterfacesCard } from "@/components/screens"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/api"
import { routerApi, type IsisAdjacency } from "@/lib/types"

export default function IsisPage() {
  const { routerId: id, clears } = useRouting()
  const { data: isis } = useSWR<{ adjacencies: IsisAdjacency[] }>(routerApi(id, "/isis"), fetcher, { refreshInterval: 15_000 })
  return (
    <>
      <Section title="IS-IS" loading={!isis} empty={isis?.adjacencies.length === 0}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">System ID</TableHead>
              <TableHead>Interface</TableHead>
              <TableHead>Level</TableHead>
              <TableHead className={clears ? undefined : "pr-6"}>State</TableHead>
              {clears && <TableHead className="pr-6" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isis?.adjacencies.map((a) => (
              <TableRow key={`${a.system_id}-${a.interface}`}>
                <TableCell className="pl-6 font-mono text-sm">{a.system_id}</TableCell>
                <TableCell className="font-mono text-sm">{a.interface}</TableCell>
                <TableCell>{a.level}</TableCell>
                <TableCell className={clears ? undefined : "pr-6"}>{a.state}</TableCell>
                {clears && (
                  <TableCell className="pr-6 text-right">
                    <ClearAction
                      routerId={id}
                      target="isis_adjacency"
                      name={a.system_id}
                      title={`the IS-IS adjacency with ${a.system_id}`}
                      disrupts="The adjacency is torn down and formed again; the routes through it are withdrawn meanwhile."
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
      {/* Prisma 0.150.6 (#64). */}
      <IsisInterfacesCard routerId={id} />
    </>
  )
}
