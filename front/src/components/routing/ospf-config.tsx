"use client"

import { useState } from "react"
import { PencilIcon, PlusIcon } from "lucide-react"

import { OtherStatements } from "@/components/config/other-statements"
import { PlacedRow } from "@/components/routing/bgp-config"
import { firstProblem, SwitchField, TextField } from "@/components/routing/fields"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { invalid } from "@/lib/config-model"
import {
  addLineEdits,
  areaLine,
  invalidArea,
  invalidInt,
  OSPF_REDISTRIBUTE,
  ospfInterfaceEdits,
  ospfRedistributeEdits,
  ospfRedistributeLine,
  ospfRouterIdEdits,
  removeLineEdits,
  type StagedEdit,
  type OspfConfig,
  type OspfInterface,
} from "@/lib/routing-config"

type Stage = (...e: StagedEdit[]) => void

/**
 * OSPF and OSPF6 (#43): router ID, areas, networks (OSPFv2), redistribution
 * and OSPF on each interface (area, cost, passive). OSPF6 has no `network`:
 * an interface joins an area with its own `ipv6 ospf6 area`.
 */
export function OspfPanel({ ospf, ospf6, editable, stage }: { ospf: OspfConfig; ospf6: OspfConfig; editable: boolean; stage: Stage }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>OSPF configuration</CardTitle>
        <CardDescription>Areas, networks, interfaces and redistribution; the neighbors are listed above.</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="ospf">
          <TabsList>
            <TabsTrigger value="ospf">OSPFv2</TabsTrigger>
            <TabsTrigger value="ospf6">OSPFv3 (ospf6)</TabsTrigger>
          </TabsList>
          {[ospf, ospf6].map((c) => (
            <TabsContent key={c.version} value={c.version} className="mt-4">
              <OspfVersionPanel c={c} editable={editable} stage={stage} />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}

function OspfVersionPanel({ c, editable, stage }: { c: OspfConfig; editable: boolean; stage: Stage }) {
  const [routerId, setRouterId] = useState<string | null>(null)
  const [area, setArea] = useState("")
  const [areaType, setAreaType] = useState<"stub" | "nssa">("stub")
  const [noSummary, setNoSummary] = useState(false)
  const [net, setNet] = useState({ prefix: "", area: "" })
  const [iface, setIface] = useState<OspfInterface | null>(null)
  const id = routerId ?? c.routerId ?? ""
  const v2 = c.version === "ospf"

  return (
    <div className="grid gap-6 lg:grid-cols-2" data-ospf={c.version}>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Router</h3>
        {!c.configured && <p className="text-muted-foreground text-sm">Not configured: setting a router ID starts it.</p>}
        <div className="flex items-end gap-2">
          <TextField
            label="Router ID"
            value={id}
            onChange={setRouterId}
            placeholder="192.0.2.1"
            error={id ? invalid({ k: "ipv4" }, id) : null}
            disabled={!editable}
          />
          {editable && (
            <Button
              variant="outline"
              size="sm"
              disabled={id === (c.routerId ?? "") || (!!id && !!invalid({ k: "ipv4" }, id))}
              onClick={() => {
                stage(...ospfRouterIdEdits(c, id.trim()))
                setRouterId(null)
              }}
            >
              Set router ID
            </Button>
          )}
        </div>

        <h3 className="pt-2 text-sm font-medium">Areas</h3>
        {c.areas.length === 0 && <p className="text-muted-foreground text-sm">No area is declared.</p>}
        {c.areas.map((a) => (
          <PlacedRow key={a.line} text={a.line} editable={editable} onRemove={() => stage(...removeLineEdits({ path: c.path, line: a.line }))} />
        ))}
        {editable && (
          <div className="flex items-end gap-2">
            <TextField label="Area" value={area} onChange={setArea} placeholder="0.0.0.1" error={invalidArea(area)} />
            <div className="grid gap-1">
              <Label className="text-xs">Area type</Label>
              <Select value={areaType} onValueChange={(t) => setAreaType(t as "stub" | "nssa")}>
                <SelectTrigger className="h-8 w-28" aria-label={`Area type in ${c.version}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stub">stub</SelectItem>
                  <SelectItem value="nssa">nssa</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <SwitchField label="No summary" checked={noSummary} onChange={setNoSummary} />
            <Button
              variant="outline"
              size="sm"
              disabled={!!invalidArea(area)}
              onClick={() => {
                stage(...addLineEdits(c.path, areaLine(area, areaType, noSummary)))
                setArea("")
              }}
            >
              <PlusIcon /> Add area
            </Button>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Redistribution</h3>
        {OSPF_REDISTRIBUTE.map((p) => (
          <RedistributeRow key={p} c={c} proto={p} editable={editable} stage={stage} />
        ))}
      </section>

      {v2 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Networks</h3>
          {c.networks.length === 0 && <p className="text-muted-foreground text-sm">No network.</p>}
          {c.networks.map((n) => (
            <PlacedRow key={n.line} text={n.line} editable={editable} onRemove={() => stage(...removeLineEdits({ path: c.path, line: n.line }))} />
          ))}
          {editable && (
            <div className="flex flex-wrap items-end gap-2">
              <TextField label="Network" value={net.prefix} onChange={(prefix) => setNet({ ...net, prefix })} placeholder="192.0.2.0/24" error={invalid({ k: "ipv4_prefix" }, net.prefix)} />
              <TextField label="Network area" value={net.area} onChange={(a) => setNet({ ...net, area: a })} placeholder="0" error={invalidArea(net.area)} className="w-28" />
              <Button
                variant="outline"
                size="sm"
                disabled={!!invalid({ k: "ipv4_prefix" }, net.prefix) || !!invalidArea(net.area)}
                onClick={() => {
                  stage(...addLineEdits(c.path, `network ${net.prefix.trim()} area ${net.area.trim()}`))
                  setNet({ prefix: "", area: "" })
                }}
              >
                <PlusIcon /> Add network
              </Button>
            </div>
          )}
        </section>
      )}

      <section className={v2 ? "space-y-2" : "space-y-2 lg:col-span-2"}>
        <h3 className="text-sm font-medium">Interfaces</h3>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Interface</TableHead>
                <TableHead>Area</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Passive</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.interfaces.map((i) => (
                <TableRow key={i.name} data-interface={i.name}>
                  <TableCell className="font-mono text-sm">{i.name}</TableCell>
                  <TableCell className="font-mono text-sm">{i.area ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{i.cost ?? "—"}</TableCell>
                  <TableCell>{i.passive ? <Badge variant="secondary">passive</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-right">
                    {editable && (
                      <Button size="icon" variant="ghost" className="size-7" aria-label={`Edit ${c.version} on ${i.name}`} onClick={() => setIface(i)}>
                        <PencilIcon />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      {c.other && c.other.length > 0 && (
        <div className="lg:col-span-2">
          <OtherStatements title={`Other statements of ${c.path[0]}`} lines={c.other} />
        </div>
      )}

      <InterfaceDialog
        c={c}
        iface={iface}
        onClose={() => setIface(null)}
        onSave={(e) => {
          stage(...e)
          setIface(null)
        }}
      />
    </div>
  )
}

function RedistributeRow({
  c,
  proto,
  editable,
  stage,
}: {
  c: OspfConfig
  proto: (typeof OSPF_REDISTRIBUTE)[number]
  editable: boolean
  stage: Stage
}) {
  const cur = c.redistribute[proto]
  const [draft, setDraft] = useState<{ on: boolean; metric: string; metricType: string; routeMap: string } | null>(null)
  const s = draft ?? { on: !!cur, metric: cur?.metric ?? "", metricType: cur?.metricType ?? "", routeMap: cur?.routeMap ?? "" }
  const v2 = c.version === "ospf"
  const next = s.on ? ospfRedistributeLine(c.version, proto, { metric: s.metric.trim(), metricType: s.metricType, routeMap: s.routeMap.trim() }) : undefined
  const metricWhy = s.metric.trim() ? invalidInt(s.metric.trim(), 0, 16777214) : null
  return (
    <div className="space-y-2 rounded-md border px-3 py-2" data-redistribute={proto}>
      <div className="flex items-center gap-2">
        <SwitchField label={`Redistribute ${proto}`} checked={s.on} onChange={(on) => setDraft({ ...s, on })} disabled={!editable} />
        {cur && <span className="text-muted-foreground ml-auto truncate font-mono text-xs">{cur.line}</span>}
      </div>
      {s.on && editable && (
        <div className="flex flex-wrap items-end gap-2">
          {v2 && <TextField label="Metric" value={s.metric} onChange={(metric) => setDraft({ ...s, metric })} error={metricWhy} className="w-24" />}
          {v2 && (
            <div className="grid gap-1">
              <Label className="text-xs">Metric type</Label>
              <Select value={s.metricType || "default"} onValueChange={(t) => setDraft({ ...s, metricType: t === "default" ? "" : t })}>
                <SelectTrigger className="h-8 w-28" aria-label={`Metric type for ${proto}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">default</SelectItem>
                  <SelectItem value="1">type 1</SelectItem>
                  <SelectItem value="2">type 2</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <TextField label="Route map" value={s.routeMap} onChange={(routeMap) => setDraft({ ...s, routeMap })} className="w-40" />
        </div>
      )}
      {editable && draft && next !== cur?.line && (
        <Button
          size="sm"
          variant="outline"
          disabled={!!metricWhy}
          onClick={() => {
            stage(...ospfRedistributeEdits(c, proto, next))
            setDraft(null)
          }}
        >
          Add to the changes
        </Button>
      )}
    </div>
  )
}

function InterfaceDialog({
  c,
  iface,
  onClose,
  onSave,
}: {
  c: OspfConfig
  iface: OspfInterface | null
  onClose: () => void
  onSave: (e: StagedEdit[]) => void
}) {
  const [s, setS] = useState({ area: "", cost: "", passive: false })
  const [shownFor, setShownFor] = useState<OspfInterface | null>(null)
  if (iface !== shownFor) {
    setShownFor(iface)
    setS({ area: iface?.area ?? "", cost: iface?.cost ?? "", passive: !!iface?.passive })
  }
  const problem = firstProblem([
    ["Area", s.area.trim() ? invalidArea(s.area.trim()) : null],
    ["Cost", s.cost.trim() ? invalidInt(s.cost.trim(), 1, 65535) : null],
  ])
  const edits = iface && !problem ? ospfInterfaceEdits(c, iface, { area: s.area.trim(), cost: s.cost.trim(), passive: s.passive }) : []
  const lines = edits.reduce((n, e) => n + e.lines.length, 0)
  return (
    <Dialog open={!!iface} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {c.version === "ospf" ? "OSPF" : "OSPFv3"} on {iface?.name}
          </DialogTitle>
          <DialogDescription>Empty fields remove the setting.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <TextField label="Area" value={s.area} onChange={(area) => setS({ ...s, area })} placeholder="0" error={s.area ? invalidArea(s.area) : null} />
          <TextField label="Cost" value={s.cost} onChange={(cost) => setS({ ...s, cost })} placeholder="1-65535" error={s.cost ? invalidInt(s.cost, 1, 65535) : null} />
          <SwitchField label="Passive (no hellos sent)" checked={s.passive} onChange={(passive) => setS({ ...s, passive })} />
        </div>
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
