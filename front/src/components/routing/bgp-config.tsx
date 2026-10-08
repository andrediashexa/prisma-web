"use client"

import { useState } from "react"
import { PencilIcon, PlusIcon, PowerIcon, SettingsIcon, Trash2Icon } from "lucide-react"

import { OtherStatements } from "@/components/config/other-statements"
import { firstProblem, SwitchField, TextField } from "@/components/routing/fields"
import { BgpStateBadge } from "@/components/widgets/bgp-widget"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { invalid } from "@/lib/config-model"
import { formatNumber, formatUptime } from "@/lib/format"
import {
  addLineEdits,
  aggregateLine,
  AFIS,
  BGP_FLAGS,
  BGP_REDISTRIBUTE,
  bgpCreateEdits,
  bgpGlobalEdits,
  bgpRedistributeEdits,
  invalidDirected,
  invalidInt,
  neighborEdits,
  neighborEditsTyped,
  neighborRemoveEdits,
  neighborRemoveEditsTyped,
  neighborShutdownEdits,
  neighborShutdownEditsTyped,
  typedNeighborForm,
  type TypedNeighborForm,
  networkLine,
  removeLineEdits,
  type StagedEdit,
  type Afi,
  type Attrs,
  type BgpConfig,
  type BgpFamily,
  type BgpNeighborConfig,
} from "@/lib/routing-config"
import type { BgpNeighbor } from "@/lib/types"

type Stage = (...e: StagedEdit[]) => void

const AFI_TITLE: Record<Afi, string> = { ipv4: "IPv4 unicast", ipv6: "IPv6 unicast" }

/**
 * BGP (#42): the process's global settings, its neighbors with their live
 * state beside their configuration, and the IPv4 and IPv6 unicast families.
 * Every change is staged; nothing reaches the router before the review.
 */
export function BgpPanel({
  bgp,
  live,
  editable,
  stage,
  release,
  clearOf,
}: {
  bgp: BgpConfig | null | undefined
  live?: BgpNeighbor[]
  editable: boolean
  stage: Stage
  /** The box's release: whether the line form may remove a neighbor with a bare `no neighbor` (0.149.23). */
  release?: string
  /** A session's clear (Prisma 0.149.25, #48), where the box has it. */
  clearOf?: (peer: string) => React.ReactNode
}) {
  const [editing, setEditing] = useState<{ neighbor?: BgpNeighborConfig } | null>(null)
  const [global, setGlobal] = useState(false)

  const configured = bgp?.neighbors ?? []
  // Sessions the box reports that the configuration does not name (another VRF) are listed, read-only.
  const others = (live ?? []).filter((l) => !configured.some((n) => n.address === l.peer))
  const liveOf = (address: string) => live?.find((l) => l.peer === address && l.vrf === "default") ?? live?.find((l) => l.peer === address)

  return (
    <Card className="py-0">
      <CardHeader className="pt-6">
        <CardTitle>BGP</CardTitle>
        <CardDescription>
          {bgp === undefined
            ? "Reading the configuration…"
            : bgp
              ? `AS ${bgp.asn}${bgp.routerId ? ` · router ID ${bgp.routerId}` : ""} · neighbors and their state`
              : "Not configured on this router."}
        </CardDescription>
        {bgp && editable && (
          <CardAction className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setGlobal(true)}>
              <SettingsIcon /> Global settings
            </Button>
            <Button size="sm" onClick={() => setEditing({})}>
              <PlusIcon /> Add neighbor
            </Button>
          </CardAction>
        )}
      </CardHeader>

      {bgp === null && editable && (
        <CardContent className="pb-6">
          <CreateBgp stage={stage} />
        </CardContent>
      )}

      {!live && bgp === undefined ? (
        <CardContent className="pb-6">
          <Skeleton className="h-16 w-full" />
        </CardContent>
      ) : configured.length + others.length === 0 ? (
        bgp && <CardContent className="text-muted-foreground pb-6 text-sm">No neighbor configured.</CardContent>
      ) : (
        <div className="overflow-x-auto pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Neighbor</TableHead>
                <TableHead>Remote AS</TableHead>
                <TableHead className="hidden sm:table-cell">Families</TableHead>
                <TableHead className="hidden sm:table-cell">Settings</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="hidden sm:table-cell text-right">Uptime</TableHead>
                <TableHead className="hidden sm:table-cell text-right">Prefixes</TableHead>
                <TableHead className="pr-6" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {configured.map((n) => {
                const l = liveOf(n.address)
                const down = n.attrs.shutdown !== undefined
                return (
                  <TableRow key={n.address} data-neighbor={n.address}>
                    <TableCell className="pl-6">
                      <div className="font-mono text-sm">
                        {n.address}
                        {n.typed?.is_peer_group && (
                          <Badge variant="outline" className="ml-2 font-sans text-[10px]">
                            peer group
                          </Badge>
                        )}
                      </div>
                      {(n.attrs.description ?? l?.description) && (
                        <div className="text-muted-foreground text-xs">{n.attrs.description ?? l?.description}</div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono">{n.attrs["remote-as"] ?? (n.attrs["peer-group"] ? `group ${n.attrs["peer-group"]}` : "—")}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <div className="flex gap-1">
                        {AFIS.filter((f) => n.families[f].attrs.activate !== undefined).map((f) => (
                          <Badge key={f} variant="outline" className="text-[10px]">
                            {f === "ipv4" ? "IPv4" : "IPv6"}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {down && <Badge variant="destructive">shutdown</Badge>}
                        {(["bfd", "next-hop-self", "ebgp-multihop", "password", "update-source"] as const)
                          .filter((a) => n.attrs[a] !== undefined)
                          .map((a) => (
                            <Badge key={a} variant="secondary" className="text-[10px]">
                              {a}
                            </Badge>
                          ))}
                      </div>
                    </TableCell>
                    <TableCell>{l ? <BgpStateBadge state={l.state} /> : <span className="text-muted-foreground text-xs">not reported</span>}</TableCell>
                    <TableCell className="hidden sm:table-cell text-right tabular-nums">{l?.uptime_seconds ? formatUptime(l.uptime_seconds) : "—"}</TableCell>
                    <TableCell className="hidden sm:table-cell text-right tabular-nums">{l ? formatNumber(l.prefixes_received) : "—"}</TableCell>
                    <TableCell className="pr-6">
                      <span className="flex justify-end gap-1">
                      {l && clearOf?.(n.address)}
                      {editable && bgp && (
                        <span className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" className="size-7" aria-label={`Edit ${n.address}`} onClick={() => setEditing({ neighbor: n })}>
                            <PencilIcon />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            aria-label={`${down ? "Enable" : "Shut down"} ${n.address}`}
                            title={down ? "Enable the session" : "Shut the session down"}
                            onClick={() => stage(...(bgp.typed ? neighborShutdownEditsTyped : neighborShutdownEdits)(bgp, n, !down))}
                          >
                            <PowerIcon className={down ? "text-emerald-600" : undefined} />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            aria-label={`Remove ${n.address}`}
                            onClick={() => stage(...(bgp.typed ? neighborRemoveEditsTyped(bgp, n) : neighborRemoveEdits(bgp, n, release)))}
                          >
                            <Trash2Icon />
                          </Button>
                        </span>
                      )}
                      </span>
                    </TableCell>
                  </TableRow>
                )
              })}
              {others.map((n) => (
                <TableRow key={`${n.vrf}-${n.peer}`}>
                  <TableCell className="pl-6">
                    <div className="font-mono text-sm">{n.peer}</div>
                    {n.description && <div className="text-muted-foreground text-xs">{n.description}</div>}
                  </TableCell>
                  <TableCell className="font-mono">{n.remote_as}</TableCell>
                  <TableCell className="hidden sm:table-cell" />
                  <TableCell className="hidden sm:table-cell text-muted-foreground text-xs">VRF {n.vrf}</TableCell>
                  <TableCell>
                    <BgpStateBadge state={n.state} />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-right tabular-nums">{n.uptime_seconds ? formatUptime(n.uptime_seconds) : "—"}</TableCell>
                  <TableCell className="hidden sm:table-cell text-right tabular-nums">{formatNumber(n.prefixes_received)}</TableCell>
                  <TableCell className="pr-6 text-right">{clearOf?.(n.peer)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {bgp && (
        <CardContent className="space-y-4 pb-6">
          <OtherStatements title={`Other statements of ${bgp.path[0]}`} lines={bgp.other} />
          <Tabs defaultValue="ipv4">
            <TabsList>
              {AFIS.map((f) => (
                <TabsTrigger key={f} value={f}>
                  {AFI_TITLE[f]}
                </TabsTrigger>
              ))}
            </TabsList>
            {AFIS.map((f) => (
              <TabsContent key={f} value={f} className="mt-4">
                <FamilyPanel bgp={bgp} family={bgp.families[f]} editable={editable} stage={stage} onEdit={(n) => setEditing({ neighbor: n })} />
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      )}

      {bgp?.typed && (
        <TypedNeighborDialog
          bgp={bgp}
          editing={editing}
          live={editing?.neighbor && liveOf(editing.neighbor.address)}
          onClose={() => setEditing(null)}
          onSave={(edits) => {
            stage(...edits)
            setEditing(null)
          }}
        />
      )}
      {bgp && !bgp.typed && (
        <NeighborDialog
          bgp={bgp}
          editing={editing}
          live={editing?.neighbor && liveOf(editing.neighbor.address)}
          onClose={() => setEditing(null)}
          onSave={(edits) => {
            stage(...edits)
            setEditing(null)
          }}
        />
      )}
      {bgp && (
        <GlobalDialog
          bgp={bgp}
          open={global}
          onClose={() => setGlobal(false)}
          onSave={(edits) => {
            stage(...edits)
            setGlobal(false)
          }}
        />
      )}
    </Card>
  )
}

function CreateBgp({ stage }: { stage: Stage }) {
  const [asn, setAsn] = useState("")
  const [routerId, setRouterId] = useState("")
  const problem = firstProblem([
    ["AS", invalidInt(asn, 1, 4294967295)],
    ["Router ID", invalid({ k: "ipv4" }, routerId)],
  ])
  return (
    <div className="flex flex-wrap items-end gap-3">
      <TextField label="AS number" value={asn} onChange={setAsn} placeholder="65000" error={invalidInt(asn, 1, 4294967295)} />
      <TextField label="Router ID" value={routerId} onChange={setRouterId} placeholder="192.0.2.1" error={invalid({ k: "ipv4" }, routerId)} />
      <Button
        disabled={!!problem}
        title={problem ?? undefined}
        onClick={() => {
          stage(...bgpCreateEdits(asn, routerId))
          setAsn("")
          setRouterId("")
        }}
      >
        <PlusIcon /> Start BGP
      </Button>
    </div>
  )
}

function GlobalDialog({
  bgp,
  open,
  onClose,
  onSave,
}: {
  bgp: BgpConfig
  open: boolean
  onClose: () => void
  onSave: (e: StagedEdit[]) => void
}) {
  const [routerId, setRouterId] = useState("")
  const [flags, setFlags] = useState<Set<string>>(new Set())
  const [shownFor, setShownFor] = useState(false)
  if (open !== shownFor) {
    setShownFor(open)
    setRouterId(bgp.routerId ?? "")
    setFlags(new Set(bgp.flags))
  }
  const why = routerId ? invalid({ k: "ipv4" }, routerId) : null
  const edits = bgpGlobalEdits(bgp, routerId.trim(), flags)
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>BGP global settings</DialogTitle>
          <DialogDescription className="font-mono">{bgp.path[0]}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <TextField label="Router ID" value={routerId} onChange={setRouterId} placeholder="192.0.2.1" error={why} hint="Empty: the router picks one" />
          {BGP_FLAGS.map(([line, text]) => (
            <SwitchField
              key={line}
              label={text}
              checked={flags.has(line)}
              onChange={(on) => {
                const next = new Set(flags)
                if (on) next.add(line)
                else next.delete(line)
                setFlags(next)
              }}
            />
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!!why || edits[0].lines.length === 0} onClick={() => onSave(edits)}>
            Add to the changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The neighbor form's state: text fields as typed, switches as booleans. */
interface NeighborState {
  address: string
  remoteAs: string
  peerGroup: string
  description: string
  password: string
  updateSource: string
  ebgpMultihop: string
  keepalive: string
  hold: string
  maximumPrefix: string
  nextHopSelf: boolean
  bfd: boolean
  shutdown: boolean
  families: Record<Afi, { activate: boolean; routeMap: string; prefixList: string; softReconfiguration: boolean }>
}

function stateOf(n?: BgpNeighborConfig): NeighborState {
  const a = n?.attrs ?? {}
  const [keepalive = "", hold = ""] = (a.timers ?? "").split(" ")
  const fam = (f: Afi) => {
    const x = n?.families[f].attrs ?? {}
    return { activate: x.activate !== undefined, routeMap: x["route-map"] ?? "", prefixList: x["prefix-list"] ?? "", softReconfiguration: x["soft-reconfiguration"] !== undefined }
  }
  return {
    address: n?.address ?? "",
    remoteAs: a["remote-as"] ?? "",
    peerGroup: a["peer-group"] ?? "",
    description: a.description ?? "",
    password: a.password ?? "",
    updateSource: a["update-source"] ?? "",
    ebgpMultihop: a["ebgp-multihop"] ?? "",
    keepalive,
    hold,
    maximumPrefix: a["maximum-prefix"] ?? "",
    nextHopSelf: a["next-hop-self"] !== undefined,
    bfd: a.bfd !== undefined,
    shutdown: a.shutdown !== undefined,
    families: { ipv4: fam("ipv4"), ipv6: fam("ipv6") },
  }
}

function attrsOf(s: NeighborState): { attrs: Attrs; families: Record<Afi, Attrs> } {
  const attrs: Attrs = {}
  const text = (k: string, v: string) => {
    if (v.trim()) attrs[k] = v.trim()
  }
  text("remote-as", s.remoteAs)
  text("peer-group", s.peerGroup)
  text("description", s.description)
  text("password", s.password)
  text("update-source", s.updateSource)
  text("ebgp-multihop", s.ebgpMultihop)
  if (s.keepalive.trim() && s.hold.trim()) attrs.timers = `${s.keepalive.trim()} ${s.hold.trim()}`
  text("maximum-prefix", s.maximumPrefix.replace(/\s+/g, " "))
  if (s.nextHopSelf) attrs["next-hop-self"] = ""
  if (s.bfd) attrs.bfd = ""
  if (s.shutdown) attrs.shutdown = ""
  const fam = (f: Afi): Attrs => {
    const x = s.families[f]
    const out: Attrs = {}
    if (x.activate) out.activate = ""
    if (x.routeMap.trim()) out["route-map"] = x.routeMap.trim().replace(/\s+/g, " ")
    if (x.prefixList.trim()) out["prefix-list"] = x.prefixList.trim().replace(/\s+/g, " ")
    if (x.softReconfiguration) out["soft-reconfiguration"] = "inbound"
    return out
  }
  return { attrs, families: { ipv4: fam("ipv4"), ipv6: fam("ipv6") } }
}

function NeighborDialog({
  bgp,
  editing,
  live,
  onClose,
  onSave,
}: {
  bgp: BgpConfig
  editing: { neighbor?: BgpNeighborConfig } | null
  live?: BgpNeighbor
  onClose: () => void
  onSave: (e: StagedEdit[]) => void
}) {
  const [s, setS] = useState<NeighborState>(stateOf())
  const [shownFor, setShownFor] = useState<typeof editing>(null)
  if (editing !== shownFor) {
    setShownFor(editing)
    setS(stateOf(editing?.neighbor))
  }
  const isNew = !editing?.neighbor
  const set = (patch: Partial<NeighborState>) => setS((x) => ({ ...x, ...patch }))
  const setFam = (f: Afi, patch: Partial<NeighborState["families"][Afi]>) =>
    setS((x) => ({ ...x, families: { ...x.families, [f]: { ...x.families[f], ...patch } } }))

  const optInt = (v: string, min: number, max: number) => (v.trim() ? invalidInt(v.trim(), min, max) : null)
  const checks: [string, string | null][] = [
    [
      "Address",
      invalid({ k: "address" }, s.address) ??
        (isNew && bgp.neighbors.some((n) => n.address === s.address.trim()) ? "already a neighbor" : null),
    ],
    [
      "Remote AS",
      !s.remoteAs.trim() && !s.peerGroup.trim()
        ? "required (or a peer group)"
        : s.remoteAs.trim() && !["internal", "external"].includes(s.remoteAs.trim())
          ? invalidInt(s.remoteAs.trim(), 1, 4294967295) && "a number from 1 to 4294967295, internal or external"
          : null,
    ],
    ["eBGP multihop", optInt(s.ebgpMultihop, 1, 255)],
    ["Keepalive", optInt(s.keepalive, 0, 65535) ?? (!s.keepalive.trim() && s.hold.trim() ? "required with the hold time" : null)],
    ["Hold time", optInt(s.hold, 0, 65535) ?? (s.keepalive.trim() && !s.hold.trim() ? "required with the keepalive" : null)],
    ...AFIS.flatMap((f): [string, string | null][] => [
      [`Route map (${f})`, invalidDirected(s.families[f].routeMap)],
      [`Prefix list (${f})`, invalidDirected(s.families[f].prefixList)],
    ]),
    ["Maximum prefixes", s.maximumPrefix.trim() && !/^\d+( \d+)?( restart \d+)?$/.test(s.maximumPrefix.trim().replace(/\s+/g, " ")) ? "<n> [<percent>] [restart <minutes>]" : null],
  ]
  const problem = firstProblem(checks)
  const why = Object.fromEntries(checks)
  const edits = problem ? [] : neighborEdits(bgp, editing?.neighbor, { address: s.address.trim(), ...attrsOf(s) })
  const lines = edits.reduce((n, e) => n + e.lines.length, 0)

  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isNew ? "Add a neighbor" : `Neighbor ${editing?.neighbor?.address}`}</DialogTitle>
          <DialogDescription>
            {live ? (
              <span className="inline-flex items-center gap-2">
                Now <BgpStateBadge state={live.state} />
                {live.uptime_seconds > 0 && <>for {formatUptime(live.uptime_seconds)}</>} · {formatNumber(live.prefixes_received)} prefixes received
              </span>
            ) : (
              `In ${bgp.path[0]}; the review shows the lines before anything is applied.`
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <TextField
            label="Address"
            value={s.address}
            onChange={(address) => {
              // A new neighbor is activated in its own address's family by default.
              const v6 = address.includes(":")
              setS((x) => ({
                ...x,
                address,
                families: isNew
                  ? { ipv4: { ...x.families.ipv4, activate: !v6 }, ipv6: { ...x.families.ipv6, activate: v6 } }
                  : x.families,
              }))
            }}
            placeholder="192.0.2.1 or 2001:db8::1"
            error={why.Address}
            disabled={!isNew}
          />
          <TextField label="Remote AS" value={s.remoteAs} onChange={(remoteAs) => set({ remoteAs })} placeholder="64500, internal, external" error={why["Remote AS"]} />
          <TextField label="Peer group" value={s.peerGroup} onChange={(peerGroup) => set({ peerGroup })} />
          <TextField label="Description" value={s.description} onChange={(description) => set({ description })} className="sm:col-span-2" />
          <TextField label="Password" type="password" value={s.password} onChange={(password) => set({ password })} hint="TCP MD5" />
          <TextField label="Update source" value={s.updateSource} onChange={(updateSource) => set({ updateSource })} placeholder="lo or an address" />
          <TextField label="eBGP multihop" value={s.ebgpMultihop} onChange={(ebgpMultihop) => set({ ebgpMultihop })} placeholder="1-255" error={why["eBGP multihop"]} />
          <TextField label="Maximum prefixes" value={s.maximumPrefix} onChange={(maximumPrefix) => set({ maximumPrefix })} placeholder="1000 90 restart 5" error={why["Maximum prefixes"]} />
          <TextField label="Keepalive (s)" value={s.keepalive} onChange={(keepalive) => set({ keepalive })} placeholder="60" error={why.Keepalive} />
          <TextField label="Hold time (s)" value={s.hold} onChange={(hold) => set({ hold })} placeholder="180" error={why["Hold time"]} />
        </div>
        <div className="flex flex-wrap gap-6">
          <SwitchField label="Next hop self" checked={s.nextHopSelf} onChange={(nextHopSelf) => set({ nextHopSelf })} />
          <SwitchField label="BFD" checked={s.bfd} onChange={(bfd) => set({ bfd })} />
          <SwitchField label="Shut down" checked={s.shutdown} onChange={(shutdown) => set({ shutdown })} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {AFIS.map((f) => (
            <div key={f} className="space-y-3 rounded-lg border p-3" data-family={f}>
              <div className="text-sm font-medium">{AFI_TITLE[f]}</div>
              <SwitchField label={`Activate in ${AFI_TITLE[f]}`} checked={s.families[f].activate} onChange={(activate) => setFam(f, { activate })} />
              <TextField
                label="Route map"
                value={s.families[f].routeMap}
                onChange={(routeMap) => setFam(f, { routeMap })}
                placeholder="NAME in"
                error={why[`Route map (${f})`]}
              />
              <TextField
                label="Prefix list"
                value={s.families[f].prefixList}
                onChange={(prefixList) => setFam(f, { prefixList })}
                placeholder="NAME in"
                error={why[`Prefix list (${f})`]}
              />
              <SwitchField
                label="Soft reconfiguration inbound"
                checked={s.families[f].softReconfiguration}
                onChange={(softReconfiguration) => setFam(f, { softReconfiguration })}
              />
            </div>
          ))}
        </div>
        {problem && s.address && <p className="text-muted-foreground text-sm">{problem}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!!problem || lines === 0} onClick={() => onSave(edits)}>
            Add to the changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The neighbor form on a box with typed BGP (Prisma 0.149.22, #46): sent as
 * one SetConfig naming the fields that change. The password is write only:
 * the box never shows it, the field starts empty and is sent only when typed.
 * Per family the route maps and prefix lists each way, next-hop-self and the
 * prefix limit are the family's own, as the box types them.
 */
function TypedNeighborDialog({
  bgp,
  editing,
  live,
  onClose,
  onSave,
}: {
  bgp: BgpConfig
  editing: { neighbor?: BgpNeighborConfig } | null
  live?: BgpNeighbor
  onClose: () => void
  onSave: (e: StagedEdit[]) => void
}) {
  const [s, setS] = useState<TypedNeighborForm>(typedNeighborForm(bgp))
  const [shownFor, setShownFor] = useState<typeof editing>(null)
  if (editing !== shownFor) {
    setShownFor(editing)
    setS(typedNeighborForm(bgp, editing?.neighbor))
  }
  const n = editing?.neighbor
  const isNew = !n
  const set = (patch: Partial<TypedNeighborForm>) => setS((x) => ({ ...x, ...patch }))
  const setFam = (f: Afi, patch: Partial<TypedNeighborForm["families"][Afi]>) =>
    setS((x) => ({ ...x, families: { ...x.families, [f]: { ...x.families[f], ...patch } } }))
  const optInt = (v: string, min: number, max: number) => (v.trim() ? invalidInt(v.trim(), min, max) : null)
  const checks: [string, string | null][] = [
    [
      "Address",
      invalid({ k: "address" }, s.address) ?? (isNew && bgp.neighbors.some((x) => x.address === s.address.trim()) ? "already a neighbor" : null),
    ],
    [
      "Remote AS",
      !s.remoteAs.trim() && !s.peerGroup.trim()
        ? "required (or a peer group)"
        : s.remoteAs.trim() && !["internal", "external"].includes(s.remoteAs.trim())
          ? invalidInt(s.remoteAs.trim(), 1, 4294967295) && "a number from 1 to 4294967295, internal or external"
          : null,
    ],
    ["eBGP multihop", optInt(s.ebgpMultihop, 1, 255)],
    ["Keepalive", optInt(s.keepalive, 0, 65535) ?? (!s.keepalive.trim() && s.hold.trim() ? "required with the hold time" : null)],
    ["Hold time", optInt(s.hold, 0, 65535) ?? (s.keepalive.trim() && !s.hold.trim() ? "required with the keepalive" : null)],
    ...AFIS.map((f) => [`Maximum prefixes (${f})`, optInt(s.families[f].maximumPrefix, 1, 4294967295)] as [string, string | null]),
  ]
  const problem = firstProblem(checks)
  const why = Object.fromEntries(checks)
  const edits = problem ? [] : neighborEditsTyped(bgp, n, { ...s, address: s.address.trim() })
  const empty = edits.every((e) => !e.typed?.length)

  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isNew ? "Add a neighbor" : `Neighbor ${n?.address}`}</DialogTitle>
          <DialogDescription>
            {live ? (
              <span className="inline-flex items-center gap-2">
                Now <BgpStateBadge state={live.state} />
                {live.uptime_seconds > 0 && <>for {formatUptime(live.uptime_seconds)}</>} · {formatNumber(live.prefixes_received)} prefixes received
              </span>
            ) : (
              `In ${bgp.path[0]}; sent as fields, the router writes the lines and the review shows them.`
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <TextField
            label="Address"
            value={s.address}
            onChange={(address) => {
              const v6 = address.includes(":")
              setS((x) => ({
                ...x,
                address,
                // A new neighbor is activated in its own address's family.
                families: isNew ? { ipv4: { ...x.families.ipv4, activate: !v6 }, ipv6: { ...x.families.ipv6, activate: v6 } } : x.families,
              }))
            }}
            placeholder="192.0.2.1 or 2001:db8::1"
            error={why.Address}
            disabled={!isNew}
          />
          <TextField label="Remote AS" value={s.remoteAs} onChange={(remoteAs) => set({ remoteAs })} placeholder="64500, internal, external" error={why["Remote AS"]} />
          <TextField label="Peer group" value={s.peerGroup} onChange={(peerGroup) => set({ peerGroup })} />
          <TextField label="Description" value={s.description} onChange={(description) => set({ description })} className="sm:col-span-2" />
          <div className="space-y-1">
            <TextField
              label="Password"
              type="password"
              value={s.password}
              onChange={(password) => set({ password })}
              placeholder={n?.typed?.password_set ? "unchanged" : "none"}
              hint={n?.typed?.password_set ? "A password is set. The router never shows it; type one to replace it, leave empty to keep it." : "TCP MD5. The router never shows it back."}
            />
            {n?.typed?.password_set && (
              <Badge variant="secondary" data-testid="password-set">
                password set
              </Badge>
            )}
          </div>
          <TextField label="Update source" value={s.updateSource} onChange={(updateSource) => set({ updateSource })} placeholder="lo or an address" />
          <TextField label="eBGP multihop" value={s.ebgpMultihop} onChange={(ebgpMultihop) => set({ ebgpMultihop })} placeholder="1-255" error={why["eBGP multihop"]} />
          <TextField label="Keepalive (s)" value={s.keepalive} onChange={(keepalive) => set({ keepalive })} placeholder="60" error={why.Keepalive} />
          <TextField label="Hold time (s)" value={s.hold} onChange={(hold) => set({ hold })} placeholder="180" error={why["Hold time"]} />
        </div>
        <div className="flex flex-wrap gap-6">
          <SwitchField label="BFD" checked={s.bfd} onChange={(bfd) => set({ bfd })} />
          <SwitchField label="Shut down" checked={s.shutdown} onChange={(shutdown) => set({ shutdown })} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {AFIS.map((f) => (
            <div key={f} className="space-y-3 rounded-lg border p-3" data-family={f}>
              <div className="text-sm font-medium">{AFI_TITLE[f]}</div>
              <SwitchField label={`Activate in ${AFI_TITLE[f]}`} checked={s.families[f].activate} onChange={(activate) => setFam(f, { activate })} />
              {f === "ipv4" && bgp.defaultIpv4Unicast && (
                <p className="text-muted-foreground text-xs">bgp default ipv4-unicast is on: a neighbor is active here without an activate line.</p>
              )}
              <div className="grid grid-cols-2 gap-2">
                <TextField label={`Route map in (${f})`} value={s.families[f].routeMapIn} onChange={(routeMapIn) => setFam(f, { routeMapIn })} />
                <TextField label={`Route map out (${f})`} value={s.families[f].routeMapOut} onChange={(routeMapOut) => setFam(f, { routeMapOut })} />
                <TextField label={`Prefix list in (${f})`} value={s.families[f].prefixListIn} onChange={(prefixListIn) => setFam(f, { prefixListIn })} />
                <TextField label={`Prefix list out (${f})`} value={s.families[f].prefixListOut} onChange={(prefixListOut) => setFam(f, { prefixListOut })} />
                <TextField
                  label={`Maximum prefixes (${f})`}
                  value={s.families[f].maximumPrefix}
                  onChange={(maximumPrefix) => setFam(f, { maximumPrefix })}
                  error={why[`Maximum prefixes (${f})`]}
                />
              </div>
              <SwitchField label={`Next hop self (${f})`} checked={s.families[f].nextHopSelf} onChange={(nextHopSelf) => setFam(f, { nextHopSelf })} />
              <SwitchField
                label={`Soft reconfiguration inbound (${f})`}
                checked={s.families[f].softReconfiguration}
                onChange={(softReconfiguration) => setFam(f, { softReconfiguration })}
              />
            </div>
          ))}
        </div>
        <OtherStatements title="Other statements of this neighbor" lines={n?.other} />
        {!problem && !empty && (
          <pre className="bg-muted/40 rounded-md border px-3 py-2 font-mono text-xs whitespace-pre-wrap" data-testid="neighbor-fields">
            {edits.flatMap((e) => e.summary ?? []).join("\n")}
          </pre>
        )}
        {problem && s.address && <p className="text-muted-foreground text-sm">{problem}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!!problem || empty} onClick={() => onSave(edits)}>
            Add to the changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FamilyPanel({
  bgp,
  family: f,
  editable,
  stage,
  onEdit,
}: {
  bgp: BgpConfig
  family: BgpFamily
  editable: boolean
  stage: Stage
  onEdit: (n: BgpNeighborConfig) => void
}) {
  const kind = f.afi === "ipv4" ? ({ k: "ipv4_prefix" } as const) : ({ k: "ipv6_prefix" } as const)
  const sample = f.afi === "ipv4" ? "192.0.2.0/24" : "2001:db8::/32"
  const [net, setNet] = useState({ prefix: "", policy: "" })
  const [agg, setAgg] = useState({ prefix: "", summaryOnly: false, policy: "", suppressPolicy: "" })
  const active = bgp.neighbors.filter((n) => Object.keys(n.families[f.afi].attrs).length > 0)

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" data-family-panel={f.afi}>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Neighbors</h3>
        {active.length === 0 && <p className="text-muted-foreground text-sm">No neighbor is set up in this family.</p>}
        {active.map((n) => {
          const a = n.families[f.afi].attrs
          return (
            <div key={n.address} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <span className="font-mono">{n.address}</span>
              {a.activate !== undefined ? <Badge variant="secondary">active</Badge> : <Badge variant="outline">not active</Badge>}
              {a["route-map"] && <span className="text-muted-foreground text-xs">route-map {a["route-map"]}</span>}
              {a["prefix-list"] && <span className="text-muted-foreground text-xs">prefix-list {a["prefix-list"]}</span>}
              {editable && (
                <Button size="icon" variant="ghost" className="ml-auto size-7" aria-label={`Edit ${n.address} in ${AFI_TITLE[f.afi]}`} onClick={() => onEdit(n)}>
                  <PencilIcon />
                </Button>
              )}
            </div>
          )
        })}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Redistribution</h3>
        {BGP_REDISTRIBUTE.map((p) => {
          const on = !!f.redistribute[p]
          return (
            <div key={p} data-redistribute={p} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <span className="font-mono">redistribute {p}</span>
              <Badge variant={on ? "secondary" : "outline"}>{on ? "on" : "off"}</Badge>
              {editable && (
                <Button variant="outline" size="sm" className="ml-auto h-7" onClick={() => stage(...bgpRedistributeEdits(f, p, !on))}>
                  {on ? "Turn off" : "Turn on"}
                </Button>
              )}
            </div>
          )
        })}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Networks</h3>
        {f.networks.length === 0 && <p className="text-muted-foreground text-sm">No network is announced.</p>}
        {f.networks.map((n) => (
          <PlacedRow key={`${n.path.join(">")}-${n.line}`} text={n.line} editable={editable} onRemove={() => stage(...removeLineEdits(n))} />
        ))}
        {editable && (
          <div className="flex flex-wrap items-end gap-2">
            <TextField label="Prefix" value={net.prefix} onChange={(prefix) => setNet({ ...net, prefix })} placeholder={sample} error={invalid(kind, net.prefix)} />
            <TextField label="Policy (optional)" value={net.policy} onChange={(policy) => setNet({ ...net, policy })} />
            <Button
              variant="outline"
              size="sm"
              disabled={!!invalid(kind, net.prefix)}
              onClick={() => {
                stage(...addLineEdits(f.path, networkLine(net.prefix.trim(), net.policy.trim())))
                setNet({ prefix: "", policy: "" })
              }}
            >
              <PlusIcon /> Add network
            </Button>
          </div>
        )}
      </section>

      {f.other && f.other.length > 0 && (
        <div className="lg:col-span-2">
          <OtherStatements title={`Other statements of address-family ${f.afi} unicast`} lines={f.other} />
        </div>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Aggregates</h3>
        {f.aggregates.length === 0 && <p className="text-muted-foreground text-sm">No aggregate.</p>}
        {f.aggregates.map((n) => (
          <PlacedRow key={`${n.path.join(">")}-${n.line}`} text={n.line} editable={editable} onRemove={() => stage(...removeLineEdits(n))} />
        ))}
        {editable && (
          <div className="flex flex-wrap items-end gap-2">
            <TextField label="Aggregate prefix" value={agg.prefix} onChange={(prefix) => setAgg({ ...agg, prefix })} placeholder={sample} error={invalid(kind, agg.prefix)} />
            <TextField label="Policy (optional)" value={agg.policy} onChange={(policy) => setAgg({ ...agg, policy })} className="w-36" />
            <TextField label="Suppress policy (optional)" value={agg.suppressPolicy} onChange={(suppressPolicy) => setAgg({ ...agg, suppressPolicy })} className="w-40" />
            <SwitchField label="Summary only" checked={agg.summaryOnly} onChange={(summaryOnly) => setAgg({ ...agg, summaryOnly })} />
            <Button
              variant="outline"
              size="sm"
              disabled={!!invalid(kind, agg.prefix)}
              onClick={() => {
                stage(...addLineEdits(f.path, aggregateLine(agg.prefix.trim(), agg.summaryOnly, agg.policy.trim(), agg.suppressPolicy.trim())))
                setAgg({ prefix: "", summaryOnly: false, policy: "", suppressPolicy: "" })
              }}
            >
              <PlusIcon /> Add aggregate
            </Button>
          </div>
        )}
      </section>
    </div>
  )
}

export function PlacedRow({ text, editable, onRemove }: { text: string; editable: boolean; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-md border px-3 py-1.5">
      <span className="font-mono text-sm">{text}</span>
      {editable && (
        <Button size="icon" variant="ghost" className="ml-auto size-7" aria-label={`Remove ${text}`} onClick={onRemove}>
          <Trash2Icon />
        </Button>
      )}
    </div>
  )
}
