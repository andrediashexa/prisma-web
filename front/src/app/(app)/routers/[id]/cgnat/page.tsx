"use client"

import { useParams } from "next/navigation"
import { useMemo, useState } from "react"
import useSWR from "swr"
import { Loader2Icon, PencilIcon, PlusIcon, SearchIcon, SettingsIcon, Trash2Icon } from "lucide-react"

import { ClearAction, useClears } from "@/components/clear-action"
import { GlobalDialog } from "@/components/cgnat/global-dialog"
import { LOG_KIND_LABEL, LoggingDialog } from "@/components/cgnat/logging-dialog"
import { PoolDialog } from "@/components/cgnat/pool-dialog"
import { ChangeReview } from "@/components/config/change-review"
import { StagedChanges } from "@/components/config/staged-changes"
import { LogExportCard } from "@/components/log-export-card"
import { CgnatWidget } from "@/components/widgets/cgnat-widget"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useConfigChanges, type ConfigChange } from "@/hooks/use-config-changes"
import { useRouterAccess, useRouterRole } from "@/hooks/use-routers"
import { api, errorMessage, fetcher } from "@/lib/api"
import {
  CGNAT_PATH,
  GLOBAL_TIMEOUTS,
  LOG_KINDS,
  poolRemoval,
  readCgnat,
  readCgnatTyped,
  targetLine,
  type CgnatConfig,
  type PoolConfig,
} from "@/lib/cgnat-config"
import { boxAllows, type Instance } from "@/lib/config-model"
import { formatNumber } from "@/lib/format"
import { useTypedConfig } from "@/lib/typed-config"
import { roleAtLeast, routerApi, type Pool, type RouterInterface, type Subscriber } from "@/lib/types"
import { cn } from "@/lib/utils"

/** `nat > cgnat` is changed by an administrator or a cgnat-operator (the grammar's roles, #28, #41). */
const CGNAT_ROLES = { roles: ["administrator", "cgnat-operator"] }

export default function CgnatPage() {
  const { id } = useParams<{ id: string }>()
  const myRole = useRouterRole(id)
  const { access, readOnly } = useRouterAccess(id)
  const { data } = useSWR<{ pools: Pool[] }>(routerApi(id, "/pools"), fetcher, { refreshInterval: 10_000 })
  const { data: tree } = useSWR<{ revision: string; instances: Instance[] }>(routerApi(id, "/config/tree"), fetcher)
  const { data: ifaces } = useSWR<{ interfaces: RouterInterface[] }>(routerApi(id, "/interfaces"), fetcher)
  const cc = useConfigChanges(id)
  const [editing, setEditing] = useState<"global" | "logging" | { pool: PoolConfig | null } | null>(null)

  // Pools and collectors typed on a box that answers GetConfig for them (Prisma 0.149.20, #46).
  const typed = useTypedConfig(id, ["pools", "logging"])
  const config = useMemo(
    () => (!tree || typed.typed === undefined ? null : typed.config ? readCgnatTyped(typed.config, tree.instances) : readCgnat(tree.instances)),
    [tree, typed.typed, typed.config],
  )
  const canChange = roleAtLeast(myRole, "operator") && !readOnly && boxAllows(access, CGNAT_ROLES)
  const staged = (key: string) => cc.changes.some((c) => c.key === key)
  // Each form stages at most one change, keyed so that editing it again replaces it.
  const stageAs = (key: string, list: ConfigChange[]) => cc.stage({ ...(list[0] ?? { path: CGNAT_PATH, lines: [], label: "" }), key })

  // Every pool the configuration names, with the box's numbers when it reports them.
  const rows = useMemo(() => {
    const names = [...(config?.pools.map((p) => p.name) ?? []), ...(data?.pools.map((p) => p.name) ?? [])]
    return [...new Set(names)].map((name) => ({
      name,
      config: config?.pools.find((p) => p.name === name) ?? null,
      stats: data?.pools.find((p) => p.name === name) ?? null,
    }))
  }, [config, data])

  return (
    <>
      {typed.error && <p className="text-destructive text-sm">Could not read the typed configuration: {typed.error.message}</p>}
      <StagedChanges cc={cc} />
      <CgnatWidget routerId={id} title="Sessions and subscribers" />

      {config ? (
        <GlobalCard config={config} canChange={canChange} staged={staged("cgnat-global")} onEdit={() => setEditing("global")} />
      ) : (
        <Skeleton className="h-32 w-full rounded-xl" />
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <LogExportCard routerId={id} />
        {config ? (
          <CollectorsCard config={config} canChange={canChange} staged={staged("cgnat-logging")} onEdit={() => setEditing("logging")} />
        ) : (
          <Skeleton className="h-40 w-full rounded-xl" />
        )}
      </div>

      <Card className="py-0">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 pt-6">
          <div className="space-y-1.5">
            <CardTitle>Pools</CardTitle>
            <CardDescription>Usage of each public address pool</CardDescription>
          </div>
          {canChange && config && (
            <Button variant="outline" size="sm" onClick={() => setEditing({ pool: null })}>
              <PlusIcon /> Add a pool
            </Button>
          )}
        </CardHeader>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Pool</TableHead>
                <TableHead>Prefixes</TableHead>
                <TableHead>Block</TableHead>
                <TableHead className="w-56">Subscribers</TableHead>
                <TableHead className="text-right">Ports in use</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">Refusals</TableHead>
                {canChange && <TableHead className="pr-6 text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data && !config && (
                <TableRow>
                  <TableCell colSpan={8} className="pl-6">
                    <Skeleton className="h-16 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {rows.map(({ name, config: pc, stats: p }) => {
                const pct = p && p.capacity > 0 ? (p.subscribers / p.capacity) * 100 : 0
                const inside = p?.prefixes_inside ?? pc?.inside ?? []
                const outside = p?.prefixes_outside ?? pc?.outside ?? []
                return (
                  <TableRow key={name} className="align-top">
                    <TableCell className="pl-6">
                      <div className="font-medium">{name}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {p && <Badge variant="outline">{p.mode}</Badge>}
                        {p && <Badge variant="outline">{p.policy}</Badge>}
                        {staged(`pool:${name}`) && <Badge variant="secondary">change staged</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {inside.map((x) => (
                        <div key={x}>
                          <span className="text-muted-foreground">in </span>
                          {x}
                        </div>
                      ))}
                      {outside.map((x) => (
                        <div key={x}>
                          <span className="text-muted-foreground">out </span>
                          {x}
                        </div>
                      ))}
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">{p ? `${p.block_size} ports` : pc?.scalars["block-size"] ? `${pc.scalars["block-size"]} ports` : "—"}</TableCell>
                    {p ? (
                      <>
                        <TableCell>
                          <div className="flex justify-between text-xs tabular-nums">
                            <span>{formatNumber(p.subscribers)}</span>
                            <span className="text-muted-foreground">
                              of {formatNumber(p.capacity)} ({formatNumber(p.guaranteed)} guaranteed)
                            </span>
                          </div>
                          <div className="bg-muted mt-1.5 h-1.5 overflow-hidden rounded-full">
                            <div
                              className={cn("h-full rounded-full", pct > 90 ? "bg-destructive" : pct > 75 ? "bg-chart-4" : "bg-primary")}
                              style={{ width: `${Math.min(100, pct)}%` }}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(p.ports_in_use)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(p.sessions)}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", p.refusals > 0 && "text-destructive")}>{formatNumber(p.refusals)}</TableCell>
                      </>
                    ) : (
                      <TableCell colSpan={4} className="text-muted-foreground text-sm">
                        Not reported by the router yet
                      </TableCell>
                    )}
                    {canChange && (
                      <TableCell className="pr-6 text-right whitespace-nowrap">
                        {pc && (
                          <>
                            <Button size="icon" variant="ghost" className="size-8" aria-label={`Edit pool ${name}`} onClick={() => setEditing({ pool: pc })}>
                              <PencilIcon />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="text-destructive size-8"
                              aria-label={`Remove pool ${name}`}
                              onClick={() => cc.stage({ ...poolRemoval(pc, !!typed.typed), key: `pool:${name}` })}
                            >
                              <Trash2Icon />
                            </Button>
                          </>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </Card>

      <SubscriberLookup routerId={id} />

      {config && (
        <>
          <GlobalDialog
            current={config.global}
            open={editing === "global"}
            interfaces={ifaces?.interfaces.map((i) => i.name) ?? config.global.interfaces.map((i) => i.name)}
            onClose={() => setEditing(null)}
            onStage={(c) => stageAs("cgnat-global", c)}
          />
          <LoggingDialog
            current={config.logging}
            typed={!!typed.typed}
            open={editing === "logging"}
            onClose={() => setEditing(null)}
            onStage={(c) => stageAs("cgnat-logging", c)}
          />
          <PoolDialog
            routerId={id}
            pool={typeof editing === "object" && editing ? editing.pool : null}
            open={typeof editing === "object" && !!editing}
            taken={config.pools.map((p) => p.name)}
            typed={!!typed.typed}
            onClose={() => setEditing(null)}
            onStage={(c) => c[0] && stageAs(`pool:${c[0].path.at(-1)!.slice("pool ".length)}`, c)}
          />
        </>
      )}
      <ChangeReview
        routerId={id}
        candidateId={cc.candidateId}
        title="Apply CGNAT changes"
        onClose={cc.closeReview}
        onStale={cc.reopen}
        onCommitted={cc.committed}
        staged={cc.staged}
      />
    </>
  )
}

const TIMEOUT_TEXT: Record<(typeof GLOBAL_TIMEOUTS)[number], string> = {
  udp: "UDP",
  icmp: "ICMP",
  "tcp-transitory": "TCP transitory",
  "tcp-established": "TCP established",
}

function Value({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate font-mono text-sm">{children}</dd>
    </div>
  )
}

const unset = <span className="text-muted-foreground font-sans">default</span>

/** `nat > cgnat` at a glance, with the form behind Edit (#41). */
function GlobalCard({ config, canChange, staged, onEdit }: { config: CgnatConfig; canChange: boolean; staged: boolean; onEdit: () => void }) {
  const g = config.global
  const sides = (s: "inside" | "outside") => g.interfaces.filter((i) => i.side === s).map((i) => i.name)
  const id = g.identity
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            CGNAT settings {staged && <Badge variant="secondary">change staged</Badge>}
          </CardTitle>
          <CardDescription>Timeouts, interfaces, subscriber identity and memory of nat › cgnat</CardDescription>
        </div>
        {canChange && (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <SettingsIcon /> Edit settings
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 lg:grid-cols-6">
          {GLOBAL_TIMEOUTS.map((t) => (
            <Value key={t} label={`Timeout ${TIMEOUT_TEXT[t]}`}>
              {g.timeouts[t] ? `${g.timeouts[t]} s` : unset}
            </Value>
          ))}
          <Value label="Block hold-down">{g.blockHolddown ? `${g.blockHolddown} s` : unset}</Value>
          <Value label="Identity">{id.kind ? (id.kind === "radius" ? `radius${id.port ? ` port ${id.port}` : ""}` : `${id.kind} ${id.path}`) : unset}</Value>
          <Value label="Inside">{sides("inside").join(", ") || <span className="text-muted-foreground font-sans">none</span>}</Value>
          <Value label="Outside">{sides("outside").join(", ") || <span className="text-muted-foreground font-sans">none</span>}</Value>
          <Value label="Session table">{g.sessionTable.buckets ? `${g.sessionTable.buckets} buckets, ${g.sessionTable.memory} MB` : unset}</Value>
          <Value label="Memory">{g.memory ? `${g.memory} GB` : unset}</Value>
        </dl>
      </CardContent>
    </Card>
  )
}

/** The configured log collectors, next to the log export's state (#41). */
function CollectorsCard({ config, canChange, staged, onEdit }: { config: CgnatConfig; canChange: boolean; staged: boolean; onEdit: () => void }) {
  const l = config.logging
  return (
    <Card className="h-fit">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            Log collectors {staged && <Badge variant="secondary">change staged</Badge>}
          </CardTitle>
          <CardDescription>
            As configured{l.export === "disable" && <span className="text-destructive"> · the export is disabled</span>}
          </CardDescription>
        </div>
        {canChange && (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <PencilIcon /> Edit collectors
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {LOG_KINDS.map((k) => {
          const t = l.targets[k]
          return (
            <div key={k} className="space-y-0.5">
              <div className="text-sm font-medium">{LOG_KIND_LABEL[k]}</div>
              {t.state === "collector" ? (
                <div className="font-mono text-xs break-all">{targetLine(k, t).replace(/^logging \S+ /, "")}</div>
              ) : (
                <div className="text-muted-foreground text-xs">{t.state === "disabled" ? "disabled" : "not set"}</div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function SubscriberLookup({ routerId }: { routerId: string }) {
  const clears = useClears(routerId)
  const [address, setAddress] = useState("")
  const [result, setResult] = useState<Subscriber | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function search(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      setResult(await api.get<Subscriber>(routerApi(routerId, `/subscriber?address=${encodeURIComponent(address.trim())}`)))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Look up subscriber</CardTitle>
        <CardDescription>Enter the subscriber&apos;s inside address to see the public IP and ports assigned to it</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={search} className="flex max-w-md gap-2">
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="100.64.1.23" className="font-mono" required />
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2Icon className="animate-spin" /> : <SearchIcon />} Search
          </Button>
        </form>
        {error && <p className="text-destructive text-sm">{error}</p>}
        {result && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>
                  <span className="text-muted-foreground">Subscriber </span>
                  <span className="font-mono">{result.address}</span>
                </span>
                <span>
                  <span className="text-muted-foreground">Pool </span>
                  {result.pool}
                </span>
                <span>
                  <span className="text-muted-foreground">Sessions </span>
                  {formatNumber(result.sessions)}
                </span>
                {clears && (
                  <ClearAction
                    routerId={routerId}
                    target="cgnat_subscriber"
                    name={result.address}
                    title={`the sessions of ${result.address}`}
                    label="Clear sessions"
                    disrupts="Every session of this subscriber ends at once. Its port blocks stay with it until the router's hold-down passes, as when sessions expire."
                  />
                )}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Public IP</TableHead>
                    <TableHead>Ports</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.blocks.map((b) => (
                    <TableRow key={`${b.public_address}-${b.first_port}`}>
                      <TableCell className="font-mono">{b.public_address}</TableCell>
                      <TableCell className="font-mono tabular-nums">
                        {b.first_port}–{b.last_port}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {result.text && <pre className="bg-muted/50 overflow-x-auto rounded-lg border p-3 font-mono text-xs">{result.text}</pre>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
