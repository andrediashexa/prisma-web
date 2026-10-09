"use client"

import useSWR from "swr"

import { Section } from "@/components/routing/section"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/api"
import { routerApi, type Bundle } from "@/lib/types"

/** The bundles and their members, an inactive member in red (moved from Routing in #88). */
export function BundlesCard({ routerId }: { routerId: string }) {
  const { data: bundles } = useSWR<{ bundles: Bundle[] }>(routerApi(routerId, "/bundles"), fetcher, { refreshInterval: 15_000 })
  return (
    <Section title="Bundles" loading={!bundles} empty={bundles?.bundles.length === 0}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-6">Bundle</TableHead>
            <TableHead>Mode</TableHead>
            <TableHead className="pr-6">Members</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {bundles?.bundles.map((b) => (
            <TableRow key={b.name}>
              <TableCell className="pl-6 font-mono text-sm">{b.name}</TableCell>
              <TableCell>{b.mode}</TableCell>
              <TableCell className="pr-6">
                <div className="flex flex-wrap gap-1">
                  {b.members.map((m) => (
                    <Badge key={m} variant={b.active_members.includes(m) ? "secondary" : "destructive"} className="font-mono">
                      {m}
                    </Badge>
                  ))}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  )
}
