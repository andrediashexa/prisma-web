"use client"

import { usePolicies } from "@/components/policies/policies-context"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { communityLists } from "@/lib/policy-lists"

const n = (v: number) => (v ? String(v) : "")

/** FRR's own `ip` / `ipv6 prefix-list`, written in the routing half: shown, not edited (#89). */
export function FrrPrefixListsCard() {
  const { frr } = usePolicies()
  if (!frr) return null
  return (
    <Card className="py-0" data-frr-prefix-lists>
      <CardHeader className="pt-6">
        <CardTitle>FRR prefix-lists</CardTitle>
        <CardDescription>
          <span className="font-mono">ip prefix-list</span> and <span className="font-mono">ipv6 prefix-list</span>, used by route-maps, neighbors
          and CGNAT pools; read only here
        </CardDescription>
      </CardHeader>
      {frr.prefix_lists.length === 0 ? (
        <CardContent className="text-muted-foreground pb-6 text-sm">None configured.</CardContent>
      ) : (
        <div className="overflow-x-auto pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">List</TableHead>
                <TableHead>Seq</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>ge / le</TableHead>
                <TableHead className="hidden pr-6 sm:table-cell">Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {frr.prefix_lists.flatMap((l) =>
                l.entries.map((e, i) => (
                  <TableRow key={`${l.family}-${l.name}-${i}`} data-frr-list={l.name}>
                    <TableCell className="pl-6">
                      {i === 0 && (
                        <>
                          <span className="font-mono font-medium">{l.name}</span>
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            {l.family === "ipv6" ? "IPv6" : "IPv4"}
                          </Badge>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">{n(e.sequence)}</TableCell>
                    <TableCell>
                      <Badge variant={e.action === "permit" ? "secondary" : "destructive"}>{e.action}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{e.prefix}</TableCell>
                    <TableCell className="tabular-nums">{e.ge || e.le ? `${n(e.ge) || "-"} / ${n(e.le) || "-"}` : ""}</TableCell>
                    <TableCell className="text-muted-foreground hidden pr-6 sm:table-cell">{e.description}</TableCell>
                  </TableRow>
                )),
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  )
}

/** FRR's `bgp community-list` and `large-community-list`: shown, not edited (#89). */
export function FrrCommunityListsCard() {
  const { frr } = usePolicies()
  if (!frr) return null
  const lists = communityLists(frr)
  return (
    <Card className="py-0" data-frr-community-lists>
      <CardHeader className="pt-6">
        <CardTitle>FRR community lists</CardTitle>
        <CardDescription>
          <span className="font-mono">bgp community-list</span> and <span className="font-mono">bgp large-community-list</span>, used by
          route-maps; read only here
        </CardDescription>
      </CardHeader>
      {lists.length === 0 ? (
        <CardContent className="text-muted-foreground pb-6 text-sm">None configured.</CardContent>
      ) : (
        <div className="overflow-x-auto pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">List</TableHead>
                <TableHead>Seq</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="pr-6">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lists.flatMap((l) =>
                l.entries.map((e, i) => (
                  <TableRow key={`${l.kind}-${l.name}-${i}`} data-frr-list={l.name}>
                    <TableCell className="pl-6">
                      {i === 0 && (
                        <>
                          <span className="font-mono font-medium">{l.name}</span>
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            {l.kind === "large-community" ? "large" : "standard"}
                            {l.style === "expanded" ? " · expanded" : ""}
                          </Badge>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">{n(e.sequence)}</TableCell>
                    <TableCell>
                      <Badge variant={e.action === "permit" ? "secondary" : "destructive"}>{e.action}</Badge>
                    </TableCell>
                    <TableCell className="pr-6 font-mono text-sm">{e.value}</TableCell>
                  </TableRow>
                )),
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  )
}

/** A box before 0.149.24 does not type policy-options (#89). */
export function ListsNotReported() {
  const { lists } = usePolicies()
  if (lists !== null) return null
  return (
    <p className="bg-muted text-muted-foreground rounded-lg border px-4 py-3 text-sm" data-lists-not-reported>
      This router does not report its lists as fields (Prisma 0.149.24 or later does); they are in its configuration, on the Configuration tab.
    </p>
  )
}
