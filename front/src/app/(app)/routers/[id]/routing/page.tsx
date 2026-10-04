"use client"

import { useParams } from "next/navigation"
import { useMemo, useState } from "react"
import useSWR from "swr"
import { ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-react"

import { ChangeReview } from "@/components/config/change-review"
import { StagedChanges } from "@/components/config/staged-changes"
import { ClearAction, useClears } from "@/components/clear-action"
import { IsisInterfacesCard, OspfInterfacesCard, RoutingLoggingCard } from "@/components/screens"
import { BgpPanel } from "@/components/routing/bgp-config"
import { OspfPanel } from "@/components/routing/ospf-config"
import { StaticRoutesPanel } from "@/components/routing/static-routes"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useConfigChanges } from "@/hooks/use-config-changes"
import { useFleetStatus, useRouterAccess, useRouterRole } from "@/hooks/use-routers"
import { api, ApiError, errorMessage, fetcher } from "@/lib/api"
import { boxAllows, type Grammar, type Instance } from "@/lib/config-model"
import { formatDateTime, formatNumber, formatUptime } from "@/lib/format"
import { readRouting, readRoutingTyped, toChange, type StagedEdit } from "@/lib/routing-config"
import { useTypedConfig } from "@/lib/typed-config"
import {
  roleAtLeast,
  routerApi,
  type BgpNeighbor,
  type Bundle,
  type IsisAdjacency,
  type ListRoutesResponse,
  type OspfNeighbor,
  type Route,
  type RouteNextHop,
  type RouteSummary,
  type VrrpRouter,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/** Output of a VTY `show` command: the route view of boxes without RouteService. */
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
  const { data: bgp, mutate: mutateBgp } = useSWR<{ neighbors: BgpNeighbor[] }>(routerApi(id, "/bgp"), fetcher, opts)
  const { data: ospf } = useSWR<{ neighbors: OspfNeighbor[] }>(routerApi(id, "/ospf"), fetcher, opts)
  const { data: isis } = useSWR<{ adjacencies: IsisAdjacency[] }>(routerApi(id, "/isis"), fetcher, opts)
  const { data: vrrp } = useSWR<{ routers: VrrpRouter[] }>(routerApi(id, "/vrrp"), fetcher, opts)
  const { data: bundles } = useSWR<{ bundles: Bundle[] }>(routerApi(id, "/bundles"), fetcher, opts)

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
  const stage = (...edits: StagedEdit[]) => edits.forEach((e) => cc.stage(toChange(e)))
  const myRole = useRouterRole(id)
  const { access, readOnly } = useRouterAccess(id)
  const release = useFleetStatus().data?.find((r) => r.id === id)?.version?.release
  // The routing modes' roles come from the grammar (administrator today).
  const roles = grammar?.modes.find((m) => m.key === "router bgp <asn>")?.roles ?? ["administrator"]
  const editable = !!routing && roleAtLeast(myRole, "operator") && !readOnly && boxAllows(access, { roles })
  const clears = useClears(id)

  return (
    <>
      {typed.error && <p className="text-destructive text-sm">Could not read the typed configuration: {typed.error.message}</p>}
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

      <div className="grid gap-4 xl:grid-cols-2">
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

      {routing && <OspfPanel ospf={routing.ospf} ospf6={routing.ospf6} editable={editable} stage={stage} />}
      {routing && <StaticRoutesPanel routes={routing.statics} interfaces={routing.interfaces} editable={editable} stage={stage} typed={!!routing.typed} />}

      <Routes routerId={id} />

      {/* Kept in sight while scrolling: the forms above and below stage into it. */}
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
          void mutateBgp()
        }}
      />

      {/* Prisma 0.150.6 (#64): OSPF and IS-IS interfaces, FRR's logging. */}
      <OspfInterfacesCard routerId={id} />
      <IsisInterfacesCard routerId={id} />
      <RoutingLoggingCard routerId={id} />
    </>
  )
}

function Section({
  title,
  description,
  loading,
  empty,
  action,
  children,
}: {
  title: string
  description?: string
  loading: boolean
  empty?: boolean
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card className="py-0">
      <CardHeader className="pt-6">
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
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
        <CardDescription>VTY output: this router predates RouteService (Prisma 0.149.2)</CardDescription>
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

/** A box older than the rpc: the back end turns UNIMPLEMENTED into 501. */
function isUnimplemented(err: unknown) {
  return err instanceof ApiError && err.code === "router_unimplemented"
}

const ALL = "all"
const PAGE_SIZES = ["100", "500", "1000", "5000"]

interface Filters {
  vrf: string
  family: string
  protocol: string
  prefix: string
  selected: boolean
  pageSize: string
}

// 100 rows fit a screen; bigger pages are a choice, scrolled inside the card.
const NO_FILTERS: Filters = { vrf: ALL, family: ALL, protocol: ALL, prefix: "", selected: false, pageSize: "100" }

/** One page already reached: its token ("" is the first) and the routes before it. */
interface PageRef {
  token: string
  offset: number
}

const FIRST_PAGE: PageRef[] = [{ token: "", offset: 0 }]

function routesPath(routerId: string, f: Filters, token: string) {
  const q = new URLSearchParams()
  if (f.vrf !== ALL) q.set("vrf", f.vrf)
  if (f.family !== ALL) q.set("family", f.family)
  if (f.protocol !== ALL) q.set("protocol", f.protocol)
  if (f.prefix) q.set("prefix", f.prefix)
  if (f.selected) q.set("selected", "true")
  q.set("page_size", f.pageSize)
  if (token) q.set("page_token", token)
  return routerApi(routerId, `/routes?${q}`)
}

/**
 * The typed routing table (#27): one page of the box's snapshot at a time.
 * The first page (no token) takes a new snapshot, so it is fetched only when
 * the filters change or on Refresh, never again on focus; going back reuses
 * the pages already read.
 */
function Routes({ routerId }: { routerId: string }) {
  const summary = useSWR<RouteSummary>(routerApi(routerId, "/routes/summary"), fetcher, {
    refreshInterval: 30_000,
    shouldRetryOnError: false,
  })
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [prefixDraft, setPrefixDraft] = useState("")
  const [pages, setPages] = useState<PageRef[]>(FIRST_PAGE)
  // Part of the key, so the same filters can still take a new snapshot.
  const [snapshot, setSnapshot] = useState(0)
  const page = pages[pages.length - 1]
  const list = useSWR<ListRoutesResponse>(
    [routesPath(routerId, filters, page.token), snapshot],
    ([path]: [string, number]) => api.get<ListRoutesResponse>(path),
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
      keepPreviousData: true,
    },
  )

  const vrfs = useMemo(() => [...new Set(summary.data?.counts.map((c) => c.vrf) ?? [])], [summary.data])
  const protocols = useMemo(() => [...new Set(summary.data?.counts.map((c) => c.protocol) ?? [])].sort(), [summary.data])

  const apply = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }))
    setPages(FIRST_PAGE)
    setSnapshot((n) => n + 1)
  }

  if (isUnimplemented(list.error)) return <RouteTables routerId={routerId} />

  const data = list.data
  const expired = list.error instanceof ApiError && list.error.code === "router_refused" && page.token !== ""

  return (
    <>
      {!isUnimplemented(summary.error) && (
        <RouteSummaryCard
          summary={summary.data}
          error={summary.error}
          onPick={(vrf, family, protocol) => apply({ vrf, family: String(family), protocol })}
        />
      )}

      <Card className="py-0">
        <CardHeader className="pt-6">
          <CardTitle>Routing table</CardTitle>
          <CardDescription>
            <span className="font-mono">&gt;</span> selected, <span className="font-mono">*</span> in the FIB
            {data?.snapshot_at && <> · snapshot taken {formatDateTime(data.snapshot_at)}</>}
          </CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => apply({})} disabled={list.isLoading}>
              <RefreshCwIcon className={cn(list.isValidating && "animate-spin")} />
              New snapshot
            </Button>
          </CardAction>
        </CardHeader>

        <CardContent className="flex flex-wrap items-end gap-3">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              apply({ prefix: prefixDraft.trim() })
            }}
          >
            <Input
              value={prefixDraft}
              onChange={(e) => setPrefixDraft(e.target.value)}
              placeholder="Prefix, e.g. 10.0.0.0/8"
              aria-label="Prefix (and the prefixes inside it)"
              className="w-56 font-mono"
            />
            <Button type="submit" variant="secondary" size="icon" aria-label="Search">
              <SearchIcon />
            </Button>
            {filters.prefix && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Clear prefix"
                onClick={() => {
                  setPrefixDraft("")
                  apply({ prefix: "" })
                }}
              >
                <XIcon />
              </Button>
            )}
          </form>
          <FilterSelect label="VRF" value={filters.vrf} onChange={(vrf) => apply({ vrf })} options={vrfs.map((v) => [v, v])} />
          <FilterSelect
            label="Family"
            value={filters.family}
            onChange={(family) => apply({ family })}
            options={[
              ["4", "IPv4"],
              ["6", "IPv6"],
            ]}
          />
          <FilterSelect
            label="Protocol"
            value={filters.protocol}
            onChange={(protocol) => apply({ protocol })}
            options={protocols.map((p) => [p, p])}
          />
          <div className="flex items-center gap-2 pb-2">
            <Switch id="routes-selected" checked={filters.selected} onCheckedChange={(selected) => apply({ selected })} />
            <Label htmlFor="routes-selected">Selected only</Label>
          </div>
        </CardContent>

        {list.error ? (
          <CardContent className="space-y-3 pb-6 text-sm">
            <p className="text-destructive">
              {expired
                ? "This snapshot expired: the router drops one nobody pages for 10 minutes. Take a new snapshot to continue."
                : errorMessage(list.error)}
            </p>
            {expired && (
              <Button variant="outline" size="sm" onClick={() => apply({})}>
                New snapshot
              </Button>
            )}
          </CardContent>
        ) : !data ? (
          <CardContent className="pb-6">
            <Skeleton className="h-64 w-full" />
          </CardContent>
        ) : data.routes.length === 0 ? (
          <CardContent className="text-muted-foreground pb-6 text-sm">No route matches these filters.</CardContent>
        ) : (
          <div className={cn("max-h-[70vh] overflow-auto", list.isValidating && "opacity-60")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Prefix</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead>VRF</TableHead>
                  <TableHead className="text-right">Distance/metric</TableHead>
                  <TableHead>Next hops</TableHead>
                  <TableHead className="pr-6 text-right">Age</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.routes.map((r, i) => (
                  <RouteRow key={`${r.vrf}-${r.prefix}-${r.protocol}-${i}`} route={r} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <CardContent className="flex flex-wrap items-center justify-between gap-3 pb-6">
          <p className="text-muted-foreground text-sm tabular-nums">
            {data && data.routes.length > 0 && (
              <>
                Routes {formatNumber(page.offset + 1)}–{formatNumber(page.offset + data.routes.length)}
                {data.total_known ? <> of {formatNumber(data.total)}</> : <> · total not known yet</>}
              </>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Select value={filters.pageSize} onValueChange={(pageSize) => apply({ pageSize })}>
              <SelectTrigger size="sm" className="w-32" aria-label="Routes per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((n) => (
                  <SelectItem key={n} value={n}>
                    {formatNumber(Number(n))} / page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" disabled={pages.length < 2} onClick={() => setPages((p) => p.slice(0, -1))}>
              <ChevronLeftIcon />
              Back
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data?.next_page_token || list.isValidating}
              onClick={() =>
                data && setPages((p) => [...p, { token: data.next_page_token, offset: page.offset + data.routes.length }])
              }
            >
              Next
              <ChevronRightIcon />
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: [string, string][]
}) {
  return (
    <div className="grid gap-1">
      <Label className="text-muted-foreground text-xs">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Any</SelectItem>
          {options.map(([v, text]) => (
            <SelectItem key={v} value={v}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function RouteRow({ route: r }: { route: Route }) {
  return (
    <TableRow className={cn("align-top", !r.selected && "text-muted-foreground")}>
      <TableCell className="pl-6 font-mono text-sm whitespace-nowrap">
        <span className="text-muted-foreground mr-2 inline-block w-4 whitespace-pre">
          {r.selected ? ">" : " "}
          {r.installed ? "*" : " "}
        </span>
        {r.prefix}
      </TableCell>
      <TableCell>
        <Badge variant={r.selected ? "secondary" : "outline"}>{r.protocol}</Badge>
      </TableCell>
      <TableCell>{r.vrf}</TableCell>
      <TableCell className="text-right font-mono text-xs tabular-nums">
        {r.distance}/{r.metric}
      </TableCell>
      <TableCell className="font-mono text-xs">
        {r.next_hops.map((nh, i) => (
          <div key={i} className={cn("whitespace-pre", !nh.active && "text-muted-foreground line-through")}>
            {nh.fib ? "* " : "  "}
            {nextHopText(nh)}
          </div>
        ))}
      </TableCell>
      <TableCell className="pr-6 text-right tabular-nums">{formatUptime(r.age_seconds)}</TableCell>
    </TableRow>
  )
}

function nextHopText(nh: RouteNextHop) {
  if (nh.blackhole) return nh.blackhole
  const where = nh.address ? `via ${nh.address}${nh.interface ? `, ${nh.interface}` : ""}` : `directly connected, ${nh.interface}`
  return nh.vrf ? `${where} (vrf ${nh.vrf})` : where
}

/** RIB and FIB counts per VRF, family and protocol; a row filters the table to it. */
function RouteSummaryCard({
  summary,
  error,
  onPick,
}: {
  summary?: RouteSummary
  error?: unknown
  onPick: (vrf: string, family: number, protocol: string) => void
}) {
  const totals = summary?.counts.reduce((t, c) => ({ rib: t.rib + c.rib, fib: t.fib + c.fib }), { rib: 0, fib: 0 })
  return (
    <Card className="py-0">
      <CardHeader className="pt-6">
        <CardTitle>Route summary</CardTitle>
        <CardDescription>Routes in the RIB and in the FIB, as zebra counts them. Pick a row to list its routes.</CardDescription>
      </CardHeader>
      {error ? (
        <CardContent className="text-destructive pb-6 text-sm">{errorMessage(error)}</CardContent>
      ) : !summary ? (
        <CardContent className="pb-6">
          <Skeleton className="h-24 w-full" />
        </CardContent>
      ) : summary.counts.length === 0 ? (
        <CardContent className="text-muted-foreground pb-6 text-sm">The router holds no routes.</CardContent>
      ) : (
        <div className="overflow-x-auto pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">VRF</TableHead>
                <TableHead>Family</TableHead>
                <TableHead>Protocol</TableHead>
                <TableHead className="text-right">RIB</TableHead>
                <TableHead className="pr-6 text-right">FIB</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.counts.map((c) => (
                <TableRow
                  key={`${c.vrf}-${c.family}-${c.protocol}`}
                  className="cursor-pointer"
                  onClick={() => onPick(c.vrf, c.family, c.protocol)}
                >
                  <TableCell className="pl-6">{c.vrf}</TableCell>
                  <TableCell>IPv{c.family}</TableCell>
                  <TableCell>{c.protocol}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(c.rib)}</TableCell>
                  <TableCell className="pr-6 text-right tabular-nums">{formatNumber(c.fib)}</TableCell>
                </TableRow>
              ))}
              {totals && (
                <TableRow className="font-medium">
                  <TableCell className="pl-6" colSpan={3}>
                    Total
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(totals.rib)}</TableCell>
                  <TableCell className="pr-6 text-right tabular-nums">{formatNumber(totals.fib)}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  )
}
