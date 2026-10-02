"use client"

import { useParams } from "next/navigation"
import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Loader2Icon, PencilIcon, PowerIcon, PowerOffIcon } from "lucide-react"

import { AddressList } from "@/components/address-list"
import { ChangeReview, discardCandidate, prepareCandidate } from "@/components/config/change-review"
import { InterfaceIcon } from "@/components/interface-icon"
import { LinkBadge } from "@/components/link-badge"
import { LinkUsage } from "@/components/link-usage"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useInterfaceRates } from "@/hooks/use-interface-rates"
import { useMe } from "@/hooks/use-me"
import { useRouterAccess } from "@/hooks/use-routers"
import { errorMessage, fetcher } from "@/lib/api"
import { formatBytes, formatNumber } from "@/lib/format"
import { hasRole, MTU_MAX, MTU_MIN, routerApi, type RouterInterface } from "@/lib/types"
import { interfaceEdit, type EditBlock } from "@/lib/vty"

type Review = { cid: string; name: string; edit: EditBlock; title: string; comment: string }

export default function InterfacesPage() {
  const { id } = useParams<{ id: string }>()
  const { data: me } = useMe()
  const { data } = useSWR<{ interfaces: RouterInterface[] }>(routerApi(id, "/interfaces"), fetcher, { refreshInterval: 10_000 })
  const { data: rates } = useInterfaceRates(id, data?.interfaces)
  const [editing, setEditing] = useState<RouterInterface | null>(null)
  const [preparing, setPreparing] = useState<string | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const { readOnly } = useRouterAccess(id)
  const canEdit = hasRole(me, "operator") && !readOnly

  /** Opens a candidate with the lines and shows the review before commit. */
  async function propose(name: string, edit: EditBlock, title: string, comment: string) {
    setPreparing(name)
    try {
      const cid = await prepareCandidate(id, [edit])
      setReview({ cid, name, edit, title, comment })
      return true
    } catch (err) {
      toast.error(errorMessage(err))
      return false
    } finally {
      setPreparing(null)
    }
  }

  return (
    <>
      <p className="text-muted-foreground text-sm">
        Changes become a candidate on Prisma: you review the diff and the <span className="font-mono">commit check</span> before applying.
      </p>
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
                          <div className="font-mono font-medium">{i.name}</div>
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
                              disabled={preparing === i.name}
                              aria-label={i.admin_up ? `Shut down ${i.name}` : `Enable ${i.name}`}
                              title={i.admin_up ? "Shut down (shutdown)" : "Enable (no shutdown)"}
                              onClick={() =>
                                propose(
                                  i.name,
                                  interfaceEdit(i.name, { adminUp: !i.admin_up }),
                                  `${i.admin_up ? "Shut down" : "Enable"} ${i.name}`,
                                  `${i.admin_up ? "shutdown" : "no shutdown"} ${i.name}`,
                                )
                              }
                            >
                              {preparing === i.name ? (
                                <Loader2Icon className="animate-spin" />
                              ) : i.admin_up ? (
                                <PowerOffIcon />
                              ) : (
                                <PowerIcon />
                              )}
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" onClick={() => setEditing(i)} aria-label={`Edit ${i.name}`}>
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

      <EditInterfaceDialog
        iface={editing}
        onClose={() => setEditing(null)}
        onPropose={async (i, change) => {
          const ok = await propose(i.name, interfaceEdit(i.name, change), `Edit ${i.name}`, `edit ${i.name}`)
          if (ok) setEditing(null)
        }}
      />
      <ChangeReview
        routerId={id}
        candidateId={review?.cid ?? null}
        title={review?.title ?? ""}
        defaultComment={review?.comment}
        onClose={() => setReview(null)}
        onStale={async () => {
          // The configuration moved: the same edit on a new candidate, and a new review of its diff (#10).
          const r = review
          if (!r) return
          setReview(null)
          await discardCandidate(id, r.cid)
          await propose(r.name, r.edit, r.title, r.comment)
        }}
      />
    </>
  )
}

function EditInterfaceDialog({
  iface,
  onClose,
  onPropose,
}: {
  iface: RouterInterface | null
  onClose: () => void
  onPropose: (i: RouterInterface, change: { description?: string; mtu?: number }) => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!iface) return
    const form = new FormData(e.currentTarget)
    const description = String(form.get("description") ?? "")
    const mtu = Number(form.get("mtu"))
    // Only send what changed, so the diff shows exactly the intent.
    const change: { description?: string; mtu?: number } = {}
    if (description.trim() !== (iface.description ?? "")) change.description = description
    if (mtu !== iface.mtu) change.mtu = mtu
    if (Object.keys(change).length === 0) {
      setError("Nothing was changed")
      return
    }
    setPending(true)
    setError(null)
    await onPropose(iface, change)
    setPending(false)
  }

  return (
    <Dialog open={!!iface} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit} key={iface?.name}>
          <DialogHeader>
            <DialogTitle>
              Edit <span className="font-mono">{iface?.name}</span>
            </DialogTitle>
            <DialogDescription>In the next step you review the diff before applying.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="description">Description</FieldLabel>
              <Input id="description" name="description" maxLength={64} defaultValue={iface?.description ?? ""} />
            </Field>
            <Field>
              <FieldLabel htmlFor="mtu">MTU</FieldLabel>
              <Input id="mtu" name="mtu" type="number" min={MTU_MIN} max={MTU_MAX} required defaultValue={iface?.mtu} />
              <FieldDescription>
                Between {MTU_MIN} and {MTU_MAX}. IPv6 requires at least {MTU_MIN}.
              </FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              Review change
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
