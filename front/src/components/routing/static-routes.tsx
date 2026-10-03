"use client"

import { useState } from "react"
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { firstProblem, TextField } from "@/components/routing/fields"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { invalid } from "@/lib/config-model"
import {
  invalidInt,
  invalidNextHop,
  STATIC_PATH,
  staticEdits,
  staticEditsTyped,
  staticLine,
  staticRemoveEditsTyped,
  type StagedEdit,
  type StaticRoute,
} from "@/lib/routing-config"

type Stage = (...e: StagedEdit[]) => void

/**
 * Static routes (#43): `router static`, IPv4 and IPv6, through a next hop or an interface.
 * `typed` (Prisma 0.149.22, #46): written with SetConfig / DeleteConfig; a VRF's own
 * routes are listed read only, as the box sets them only as lines of their `vrf` block.
 */
export function StaticRoutesPanel({
  routes,
  interfaces,
  editable,
  stage,
  typed = false,
}: {
  routes: StaticRoute[]
  interfaces: string[]
  editable: boolean
  stage: Stage
  typed?: boolean
}) {
  const [editing, setEditing] = useState<{ route?: StaticRoute } | null>(null)
  return (
    <Card className="py-0">
      <CardHeader className="pt-6">
        <CardTitle>Static routes</CardTitle>
        <CardDescription className="font-mono">{STATIC_PATH[0]}</CardDescription>
        {editable && (
          <CardAction>
            <Button size="sm" onClick={() => setEditing({})}>
              <PlusIcon /> Add route
            </Button>
          </CardAction>
        )}
      </CardHeader>
      {routes.length === 0 ? (
        <CardContent className="text-muted-foreground pb-6 text-sm">No static route.</CardContent>
      ) : (
        <div className="overflow-x-auto pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Prefix</TableHead>
                <TableHead>Next hop</TableHead>
                <TableHead className="text-right">Distance</TableHead>
                <TableHead className="text-right">Tag</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="pr-6" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {routes.map((r) => (
                <TableRow key={`${r.vrf ?? ""} ${r.line}`} data-route={r.prefix} data-vrf={r.vrf}>
                  <TableCell className="pl-6 font-mono text-sm">
                    {r.prefix}
                    <Badge variant="outline" className="ml-2 text-[10px]">
                      IPv{r.family}
                    </Badge>
                    {r.vrf && (
                      <Badge variant="secondary" className="ml-1 text-[10px]" title="A VRF's route: a line of its vrf block, edited on the Settings page">
                        VRF {r.vrf}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {r.nextHop}
                    {r.extra && <span className="text-muted-foreground ml-1 text-xs">{r.extra.join(" ")}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.distance ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.tag ?? "—"}</TableCell>
                  <TableCell className="text-sm">{r.description}</TableCell>
                  <TableCell className="pr-6">
                    {editable && !r.vrf && (
                      <span className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" className="size-7" aria-label={`Edit route ${r.prefix} via ${r.nextHop}`} onClick={() => setEditing({ route: r })}>
                          <PencilIcon />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          aria-label={`Remove route ${r.prefix} via ${r.nextHop}`}
                          onClick={() => stage(...(typed ? staticRemoveEditsTyped(r) : [{ path: STATIC_PATH, lines: [`no ${r.line}`] }]))}
                        >
                          <Trash2Icon />
                        </Button>
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <RouteDialog
        typed={typed}
        editing={editing}
        interfaces={interfaces}
        onClose={() => setEditing(null)}
        onSave={(e) => {
          stage(...e)
          setEditing(null)
        }}
      />
    </Card>
  )
}

function RouteDialog({
  editing,
  interfaces,
  onClose,
  onSave,
  typed,
}: {
  typed: boolean
  editing: { route?: StaticRoute } | null
  interfaces: string[]
  onClose: () => void
  onSave: (e: StagedEdit[]) => void
}) {
  const empty = { prefix: "", nextHop: "", distance: "", tag: "", description: "" }
  const [s, setS] = useState(empty)
  const [shownFor, setShownFor] = useState<typeof editing>(null)
  if (editing !== shownFor) {
    setShownFor(editing)
    const r = editing?.route
    setS(r ? { prefix: r.prefix, nextHop: r.nextHop, distance: r.distance ?? "", tag: r.tag ?? "", description: r.description ?? "" } : empty)
  }
  const why = {
    prefix: invalid({ k: "prefix" }, s.prefix.trim()),
    nextHop: invalidNextHop(s.prefix.trim(), s.nextHop.trim()),
    distance: s.distance.trim() ? invalidInt(s.distance.trim(), 1, 255) : null,
    tag: s.tag.trim() ? invalidInt(s.tag.trim(), 1, 4294967295) : null,
  }
  const problem = firstProblem([
    ["Prefix", why.prefix],
    ["Next hop", why.nextHop],
    ["Distance", why.distance],
    ["Tag", why.tag],
  ])
  const line = staticLine({
    prefix: s.prefix.trim(),
    nextHop: s.nextHop.trim(),
    distance: s.distance.trim(),
    tag: s.tag.trim(),
    description: s.description.trim(),
  })
  const listId = "static-next-hop-interfaces"
  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing?.route ? "Change a static route" : "Add a static route"}</DialogTitle>
          <DialogDescription>IPv4 or IPv6; the next hop is an address of the same family or an interface.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Prefix" value={s.prefix} onChange={(prefix) => setS({ ...s, prefix })} placeholder="192.0.2.0/24 or 2001:db8::/32" error={why.prefix} />
          <TextField label="Next hop" value={s.nextHop} onChange={(nextHop) => setS({ ...s, nextHop })} placeholder="203.0.113.1 or wan0" error={why.nextHop} list={listId} />
          <datalist id={listId}>
            {interfaces.map((i) => (
              <option key={i} value={i} />
            ))}
          </datalist>
          <TextField label="Distance" value={s.distance} onChange={(distance) => setS({ ...s, distance })} placeholder="1-255" error={why.distance} />
          <TextField label="Tag" value={s.tag} onChange={(tag) => setS({ ...s, tag })} error={why.tag} />
          <TextField label="Description" value={s.description} onChange={(description) => setS({ ...s, description })} className="sm:col-span-2" />
        </div>
        {!problem && <p className="rounded-md border px-3 py-2 font-mono text-sm">{line}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!!problem || line === editing?.route?.line}
            onClick={() =>
              onSave(
                typed
                  ? staticEditsTyped(editing?.route, {
                      prefix: s.prefix.trim(),
                      nextHop: s.nextHop.trim(),
                      distance: s.distance.trim(),
                      tag: s.tag.trim(),
                      description: s.description.trim(),
                    })
                  : staticEdits(editing?.route, line),
              )
            }
          >
            Add to the changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
