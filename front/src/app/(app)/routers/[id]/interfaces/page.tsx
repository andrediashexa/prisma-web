"use client"

import { useParams } from "next/navigation"
import { useState } from "react"
import useSWR from "swr"
import { BoxesIcon, Loader2Icon, PencilIcon, PowerIcon, PowerOffIcon } from "lucide-react"

import { AddressList } from "@/components/address-list"
import { ClearAction, useClears } from "@/components/clear-action"
import { ChangeReview } from "@/components/config/change-review"
import { StagedChanges } from "@/components/config/staged-changes"
import { InterfaceForm, type InterfaceEditing } from "@/components/interface-form"
import { InterfaceIcon } from "@/components/interface-icon"
import { LinkBadge } from "@/components/link-badge"
import { LinkUsage } from "@/components/link-usage"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useConfigChanges } from "@/hooks/use-config-changes"
import { useInterfaceRates } from "@/hooks/use-interface-rates"
import { useRouterAccess, useRouterRole } from "@/hooks/use-routers"
import { fetcher } from "@/lib/api"
import { boxAllows, type Instance } from "@/lib/config-model"
import { formatBytes, formatNumber } from "@/lib/format"
import {
  emptyInterface,
  INTERFACE_ROLES,
  interfaceChange,
  readInterfaces,
  readInterfacesTyped,
  shutdownChange,
  type InterfaceConfig,
} from "@/lib/interface-config"
import { useTypedConfig } from "@/lib/typed-config"
import { roleAtLeast, routerApi, type RouterInterface } from "@/lib/types"

export default function InterfacesPage() {
  const { id } = useParams<{ id: string }>()
  const { data, mutate } = useSWR<{ interfaces: RouterInterface[] }>(routerApi(id, "/interfaces"), fetcher, { refreshInterval: 10_000 })
  const clears = useClears(id)
  const { data: tree } = useSWR<{ instances: Instance[] }>(routerApi(id, "/config/tree"), fetcher)
  // Typed on a box that answers GetConfig for interfaces (Prisma 0.149.20, #46); lines otherwise.
  const typed = useTypedConfig(id, ["interfaces"])
  const { data: rates } = useInterfaceRates(id, data?.interfaces)
  const { access, readOnly } = useRouterAccess(id)
  const myRole = useRouterRole(id)
  // Ports and bundles are changed by the box's administrators only (the grammar's roles).
  const canEdit = roleAtLeast(myRole, "operator") && !readOnly && boxAllows(access, { roles: INTERFACE_ROLES })
  const cc = useConfigChanges(id)
  const [editing, setEditing] = useState<InterfaceEditing | null>(null)
  const [creating, setCreating] = useState(false)
  // The form's state behind each staged change, so editing again continues from it.
  const [drafts, setDrafts] = useState<Record<string, InterfaceConfig>>({})

  // Read once the box has said whether it types interfaces.
  const ready = !!tree && typed.typed !== undefined
  const configs = !tree || typed.typed === undefined ? [] : typed.config ? readInterfacesTyped(typed.config.interfaces, tree.instances) : readInterfaces(tree.instances)
  const staged = (name: string) => cc.changes.some((c) => c.key === `interface ${name}`)
  // Interfaces as the form sees them: staged state over the running one, bundles being created included.
  const known = new Set(configs.map((c) => c.name))
  const all = [
    ...configs.map((c) => (staged(c.name) && drafts[c.name]) || c),
    ...Object.values(drafts).filter((d) => !known.has(d.name) && staged(d.name)),
  ]

  function edit(name: string) {
    const running = configs.find((c) => c.name === name) ?? emptyInterface(name)
    const draft = staged(name) ? drafts[name] : undefined
    setEditing({ running, start: draft ?? running, isNew: !known.has(name) })
  }

  /** Shut down or enable at once: one line, straight to the review. */
  function toggle(i: RouterInterface) {
    void cc.review([shutdownChange(i.name, i.admin_up, !!typed.typed)])
  }

  const reviewTitle =
    cc.reviewed.length === 1 ? cc.reviewed[0].label.replace(/^./, (c) => c.toUpperCase()) : `Apply ${cc.reviewed.length} interface changes`

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Changes become a candidate on Prisma: you review the diff and the <span className="font-mono">commit check</span> before applying.
        </p>
        {(canEdit || clears) && (
          <div className="flex flex-wrap gap-2">
            {clears && (
              <ClearAction
                routerId={id}
                target="interface_counters"
                title="every interface's counters"
                label="Clear counters"
                disrupts="Every count of every interface restarts from zero, the ones the charts and the history read included. Traffic is not affected."
                onDone={() => mutate()}
              />
            )}
            {/* A bundle being created has no row until it is committed. */}
            {all
              .filter((i) => !known.has(i.name))
              .map((i) => (
                <Button key={i.name} variant="outline" size="sm" onClick={() => edit(i.name)} aria-label={`Edit ${i.name}`}>
                  <PencilIcon /> <span className="font-mono">{i.name}</span>
                  <Badge variant="outline">staged</Badge>
                </Button>
              ))}
            {canEdit && (
              <Button variant="outline" size="sm" disabled={!ready} onClick={() => setCreating(true)}>
                <BoxesIcon /> New bundle
              </Button>
            )}
          </div>
        )}
      </div>
      <Card className="py-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Interface</TableHead>
                <TableHead>Addresses</TableHead>
                <TableHead className="text-right">MTU</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Errors / drops</TableHead>
                <TableHead title="Link speed, and the busier direction over it">Speed / usage</TableHead>
                <TableHead>State</TableHead>
                {canEdit && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data &&
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={9} className="pl-4">
                      <Skeleton className="h-10 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {data?.interfaces.map((i) => {
                const c = i.counters
                const loopback = i.name === "lo"
                return (
                  <TableRow key={i.name} className="align-top">
                    <TableCell className="pl-4">
                      <div className="flex items-start gap-3">
                        <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
                          <InterfaceIcon name={i.name} className="size-4" />
                        </span>
                        <div>
                          <div className="flex items-center gap-2 font-mono font-medium">
                            {i.name}
                            {staged(i.name) && <Badge variant="outline">staged</Badge>}
                          </div>
                          <div className="text-muted-foreground text-xs">{i.description || "No description"}</div>
                          <div className="text-muted-foreground font-mono text-[11px]">
                            {[i.mac_address, i.linux_name && `linux: ${i.linux_name}`].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <AddressList addresses={i.addresses} />
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{i.mtu}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c && (
                        <>
                          <div>{formatBytes(c.rx_bytes)}</div>
                          <div className="text-muted-foreground text-xs">{formatNumber(c.rx_packets)} pkts</div>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c && (
                        <>
                          <div>{formatBytes(c.tx_bytes)}</div>
                          <div className="text-muted-foreground text-xs">{formatNumber(c.tx_packets)} pkts</div>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c && (
                        <span className={c.rx_errors + c.tx_errors + c.drops > 0 ? "text-destructive" : "text-muted-foreground"}>
                          {formatNumber(c.rx_errors + c.tx_errors)} / {formatNumber(c.drops)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {!loopback && <LinkUsage iface={i} rate={rates?.[i.name]} />}
                    </TableCell>
                    <TableCell>
                      <LinkBadge iface={i} />
                    </TableCell>
                    {canEdit && (
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {!loopback && (
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={cc.preparing}
                              aria-label={i.admin_up ? `Shut down ${i.name}` : `Enable ${i.name}`}
                              title={i.admin_up ? "Shut down (shutdown)" : "Enable (no shutdown)"}
                              onClick={() => toggle(i)}
                            >
                              {cc.preparing ? (
                                <Loader2Icon className="animate-spin" />
                              ) : i.admin_up ? (
                                <PowerOffIcon />
                              ) : (
                                <PowerIcon />
                              )}
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" disabled={!ready} onClick={() => edit(i.name)} aria-label={`Edit ${i.name}`}>
                            <PencilIcon />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </Card>

      {typed.error && <p className="text-destructive text-sm">Could not read the typed configuration: {typed.error.message}</p>}
      <StagedChanges cc={cc} />

      <InterfaceForm
        routerId={id}
        editing={editing}
        all={all}
        typedBox={!!typed.typed}
        onClose={() => setEditing(null)}
        onSave={(running, cur) => {
          cc.stage(interfaceChange(running, cur, !!typed.typed))
          setDrafts((d) => ({ ...d, [cur.name]: cur }))
          setEditing(null)
        }}
      />
      <NewBundleDialog
        open={creating}
        taken={all.map((i) => i.name)}
        onClose={() => setCreating(false)}
        onCreate={(name) => {
          setCreating(false)
          setEditing({ running: emptyInterface(name), start: emptyInterface(name), isNew: true })
        }}
      />
      <ChangeReview
        routerId={id}
        candidateId={cc.candidateId}
        title={reviewTitle}
        defaultComment={cc.reviewed.map((c) => c.label).join("; ")}
        onClose={cc.closeReview}
        onStale={cc.reopen}
        onCommitted={cc.committed}
        staged={cc.staged}
      />
    </>
  )
}

/** Names a new bundle: `interface bond<n>` creates it with its first lines. */
function NewBundleDialog({
  open,
  taken,
  onClose,
  onCreate,
}: {
  open: boolean
  taken: string[]
  onClose: () => void
  onCreate: (name: string) => void
}) {
  const [n, setN] = useState("")
  const name = `bond${n}`
  const why = !n ? null : !/^\d{1,9}$/.test(n) ? "a number" : taken.includes(name) ? `${name} already exists` : null
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
        setN("")
      }}
    >
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (n && !why) onCreate(name)
            setN("")
          }}
        >
          <DialogHeader>
            <DialogTitle>New bundle</DialogTitle>
            <DialogDescription>A bond of ports with LACP. Name it, then choose its members and addresses.</DialogDescription>
          </DialogHeader>
          <Field className="py-4" data-invalid={!!why}>
            <FieldLabel htmlFor="bundle-number">Bundle number</FieldLabel>
            <div className="flex items-center gap-1">
              <span className="font-mono text-sm">bond</span>
              <Input id="bundle-number" inputMode="numeric" autoFocus value={n} onChange={(e) => setN(e.target.value.trim())} className="w-32 font-mono" />
            </div>
            {why ? <FieldError>{why}</FieldError> : <FieldDescription>It reaches the router with its settings, after the review.</FieldDescription>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!n || !!why}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
