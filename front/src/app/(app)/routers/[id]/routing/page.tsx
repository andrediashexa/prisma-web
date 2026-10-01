"use client"

import { useParams } from "next/navigation"
import useSWR from "swr"

import { BgpStateBadge } from "@/components/widgets/bgp-widget"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, fetcher } from "@/lib/api"
import { formatNumber, formatUptime } from "@/lib/format"
import {
  routerApi,
  type BgpNeighbor,
  type Bundle,
  type IsisAdjacency,
  type OspfNeighbor,
  type VrrpRouter,
} from "@/lib/types"

/** Output of a VTY `show` command (the proto has no typed routes yet). */
function useShow(routerId: string, command: string) {
  return useSWR<{ text: string }>(
    [routerApi(routerId, "/show"), command],
    ([url, cmd]: [string, string]) => api.post<{ text: string }>(url, { command: cmd }),
    { refreshInterval: 30_000, revalidateOnFocus: false },
  )
}

export default function RoutingPage() {
  const { id } = useParams<{ id: string }>()
  const opts = { refreshInterval: 15_000 }
  const { data: bgp } = useSWR<{ neighbors: BgpNeighbor[] }>(routerApi(id, "/bgp"), fetcher, opts)
  const { data: ospf } = useSWR<{ neighbors: OspfNeighbor[] }>(routerApi(id, "/ospf"), fetcher, opts)
  const { data: isis } = useSWR<{ adjacencies: IsisAdjacency[] }>(routerApi(id, "/isis"), fetcher, opts)
  const { data: vrrp } = useSWR<{ routers: VrrpRouter[] }>(routerApi(id, "/vrrp"), fetcher, opts)
  const { data: bundles } = useSWR<{ bundles: Bundle[] }>(routerApi(id, "/bundles"), fetcher, opts)

  return (
    <>
      <Section title="BGP" description="Neighbors and received prefixes" loading={!bgp} empty={bgp?.neighbors.length === 0}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Neighbor</TableHead>
              <TableHead>Remote AS</TableHead>
              <TableHead>VRF</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Uptime</TableHead>
              <TableHead className="pr-6 text-right">Prefixes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bgp?.neighbors.map((n) => (
              <TableRow key={`${n.vrf}-${n.peer}`}>
                <TableCell className="pl-6">
                  <div className="font-mono text-sm">{n.peer}</div>
                  {n.description && <div className="text-muted-foreground text-xs">{n.description}</div>}
                </TableCell>
                <TableCell className="font-mono">{n.remote_as}</TableCell>
                <TableCell>{n.vrf}</TableCell>
                <TableCell>
                  <BgpStateBadge state={n.state} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{n.uptime_seconds ? formatUptime(n.uptime_seconds) : "—"}</TableCell>
                <TableCell className="pr-6 text-right tabular-nums">{formatNumber(n.prefixes_received)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="OSPF / OSPFv3" loading={!ospf} empty={ospf?.neighbors.length === 0}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Router ID</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Interface</TableHead>
                <TableHead className="pr-6">State</TableHead>
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
                  <TableCell className="pr-6">{n.state}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>

        <Section title="IS-IS" loading={!isis} empty={isis?.adjacencies.length === 0}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">System ID</TableHead>
                <TableHead>Interface</TableHead>
                <TableHead>Level</TableHead>
                <TableHead className="pr-6">State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isis?.adjacencies.map((a) => (
                <TableRow key={`${a.system_id}-${a.interface}`}>
                  <TableCell className="pl-6 font-mono text-sm">{a.system_id}</TableCell>
                  <TableCell className="font-mono text-sm">{a.interface}</TableCell>
                  <TableCell>{a.level}</TableCell>
                  <TableCell className="pr-6">{a.state}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>

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
      </div>

      <RouteTables routerId={id} />
    </>
  )
}

function Section({
  title,
  description,
  loading,
  empty,
  children,
}: {
  title: string
  description?: string
  loading: boolean
  empty?: boolean
  children: React.ReactNode
}) {
  return (
    <Card className="py-0">
      <CardHeader className="pt-6">
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      {loading ? (
        <CardContent className="pb-6">
          <Skeleton className="h-16 w-full" />
        </CardContent>
      ) : empty ? (
        <CardContent className="text-muted-foreground pb-6 text-sm">Nothing configured.</CardContent>
      ) : (
        <div className="overflow-x-auto pb-2">{children}</div>
      )}
    </Card>
  )
}

function RouteTables({ routerId }: { routerId: string }) {
  const v4 = useShow(routerId, "show ip route")
  const v6 = useShow(routerId, "show ipv6 route")
  return (
    <Card>
      <CardHeader>
        <CardTitle>Routing table</CardTitle>
        <CardDescription>VTY output (the proto does not expose typed routes yet)</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="v4">
          <TabsList>
            <TabsTrigger value="v4">IPv4</TabsTrigger>
            <TabsTrigger value="v6">IPv6</TabsTrigger>
          </TabsList>
          {(
            [
              ["v4", v4],
              ["v6", v6],
            ] as const
          ).map(([k, q]) => (
            <TabsContent key={k} value={k} className="mt-4">
              {q.error ? (
                <p className="text-destructive text-sm">{q.error.message}</p>
              ) : !q.data ? (
                <Skeleton className="h-48 w-full" />
              ) : (
                <pre className="bg-muted/50 max-h-[60vh] overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed">{q.data.text}</pre>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}
