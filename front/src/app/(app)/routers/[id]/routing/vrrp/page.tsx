"use client"

import useSWR from "swr"

import { useRouting } from "@/components/routing/routing-context"
import { Section } from "@/components/routing/section"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/api"
import { routerApi, type VrrpRouter } from "@/lib/types"

export default function VrrpPage() {
  const { routerId: id } = useRouting()
  const { data: vrrp } = useSWR<{ routers: VrrpRouter[] }>(routerApi(id, "/vrrp"), fetcher, { refreshInterval: 15_000 })
  return (
    <>
      <Section title="VRRP" loading={!vrrp} empty={vrrp?.routers.length === 0}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Interface</TableHead>
              <TableHead>VR</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="pr-6">Addresses</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {vrrp?.routers.map((v) => (
              <TableRow key={`${v.interface}-${v.vr_id}-${v.family}`}>
                <TableCell className="pl-6 font-mono text-sm">{v.interface}</TableCell>
                <TableCell className="tabular-nums">
                  {v.vr_id} <Badge variant="outline" className="ml-1 text-[10px]">IPv{v.family}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={v.state === "master" ? "default" : "secondary"}>{v.state}</Badge>
                  <span className="text-muted-foreground ml-2 text-xs">prio {v.priority}</span>
                </TableCell>
                <TableCell className="pr-6 font-mono text-xs">{v.addresses.join(", ")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </>
  )
}
