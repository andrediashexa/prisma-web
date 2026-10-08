"use client"

import Link from "next/link"
import useSWR from "swr"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { fetcher } from "@/lib/api"
import { routerApi } from "@/lib/types"

interface ManagementState {
  vrf: string
  table: number
  ipv4_table: number
  ipv6_table: number
  known: boolean
  listeners_answer_on_vrf: boolean
  listeners_bind_vrf_address: boolean
  ipv6_addresses_kept: boolean
  interfaces: string[]
  in_effect: boolean
}

const table = (t: number) => (t ? `table ${t}` : "the main table")

/**
 * Where the router's management lives (Prisma 0.152.4, #82): the main table, or a VRF of its own
 * whose default the box's own traffic leaves by while the main table's default is the
 * subscribers'. Changed in Settings at `system > management`. Not shown before 0.152.4.
 */
export function ManagementCard({ routerId }: { routerId: string }) {
  const { data } = useSWR<{ management?: ManagementState | null; management_text?: string }>(routerApi(routerId, "/system"), fetcher, {
    refreshInterval: 30_000,
  })
  const m = data?.management
  if (!m) return null
  const inVrf = !!m.vrf
  const settings = [
    ["Main-table listeners answer on the VRF", m.listeners_answer_on_vrf],
    ["Listeners can bind the VRF's address", m.listeners_bind_vrf_address],
    ["IPv6 addresses kept across a VRF move", m.ipv6_addresses_kept],
  ] as const
  return (
    <Card data-management>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Management
          <Badge variant={inVrf ? "secondary" : "outline"} data-management-where>
            {inVrf ? `VRF ${m.vrf}` : "main table"}
          </Badge>
        </CardTitle>
        <CardDescription>Where the router&apos;s own traffic (its API, SSH, SNMP, syslog) is routed</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!m.in_effect && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-amber-900 dark:text-amber-200" data-management-not-in-effect>
            The router does not have in effect what is configured: until the next commit that changes it, or the next boot.
          </p>
        )}
        {inVrf ? (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground text-xs">VRF</dt>
              <dd className="font-mono">
                {m.vrf} · {table(m.table)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">The router&apos;s own traffic goes to</dt>
              <dd className="font-mono">
                IPv4 {table(m.ipv4_table)} · IPv6 {table(m.ipv6_table)}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground text-xs">Interfaces in the VRF</dt>
              <dd className="font-mono">{m.interfaces.length ? m.interfaces.join(", ") : "none"}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-muted-foreground">The router&apos;s own traffic shares the main table, and its default route, with the subscribers.</p>
        )}
        {inVrf && (
          <ul className="space-y-1 text-xs" data-management-host>
            {!m.known && <li className="text-amber-700 dark:text-amber-300">The host&apos;s settings could not be read.</li>}
            {m.known && settings.map(([label, on]) => <li key={label}>{on ? "✓" : "✗"} {label}</li>)}
          </ul>
        )}
        <p className="text-muted-foreground text-xs">
          Changed in{" "}
          <Link href={`/routers/${routerId}/settings?at=${encodeURIComponent("system > management")}`} className="text-primary underline-offset-4 hover:underline">
            Settings, system &gt; management
          </Link>
          . Moving management into or out of a VRF can end the connections made over it, prisma-web&apos;s to this router included.
        </p>
        {data?.management_text?.trim() && (
          <details>
            <summary className="text-muted-foreground cursor-pointer text-xs">The router&apos;s screen (show system management)</summary>
            <pre className="bg-muted/50 mt-2 overflow-x-auto rounded-md border p-2 font-mono text-xs">{data.management_text.trimEnd()}</pre>
          </details>
        )}
      </CardContent>
    </Card>
  )
}
