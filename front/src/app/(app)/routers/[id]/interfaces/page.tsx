"use client"

import { useParams } from "next/navigation"
import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Loader2Icon, PencilIcon } from "lucide-react"

import { AddressList } from "@/components/address-list"
import { InterfaceIcon, KIND_LABEL } from "@/components/interface-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useMe } from "@/hooks/use-me"
import { api, errorMessage, fetcher } from "@/lib/api"
import { formatBytes, formatNumber } from "@/lib/format"
import { hasRole, MTU_MAX, MTU_MIN, routerApi, type InterfaceUpdate, type RouterInterface } from "@/lib/types"

export default function InterfacesPage() {
  const { id } = useParams<{ id: string }>()
  const { data: me } = useMe()
  const { data, mutate } = useSWR<RouterInterface[]>(routerApi(id, "/interfaces"), fetcher, { refreshInterval: 10_000 })
  const [editing, setEditing] = useState<RouterInterface | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const canEdit = hasRole(me, "operator")

  async function update(name: string, body: InterfaceUpdate) {
    const updated = await api.patch<RouterInterface>(routerApi(id, `/interfaces/${encodeURIComponent(name)}`), body)
    await mutate((list) => list?.map((i) => (i.name === name ? updated : i)), { revalidate: false })
    return updated
  }

  async function toggle(i: RouterInterface, admin_up: boolean) {
    setToggling(i.name)
    try {
      await update(i.name, { admin_up })
      toast.success(`${i.name} ${admin_up ? "ativada" : "desativada"}`)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setToggling(null)
    }
  }

  return (
    <>
      <Card className="py-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Interface</TableHead>
                <TableHead>Endereços</TableHead>
                <TableHead className="text-right">MTU</TableHead>
                <TableHead className="text-right">Recebido</TableHead>
                <TableHead className="text-right">Enviado</TableHead>
                <TableHead className="text-right">Erros</TableHead>
                <TableHead>Ativa</TableHead>
                {canEdit && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data &&
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={8} className="pl-4">
                      <Skeleton className="h-10 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {data?.map((i) => (
                <TableRow key={i.name} className="align-top">
                  <TableCell className="pl-4">
                    <div className="flex items-start gap-3">
                      <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
                        <InterfaceIcon kind={i.kind} className="size-4" />
                      </span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium">{i.name}</span>
                          <Badge variant="outline" className="text-[10px]">
                            {KIND_LABEL[i.kind]}
                          </Badge>
                        </div>
                        <div className="text-muted-foreground text-xs">{i.description ?? "Sem descrição"}</div>
                        {i.mac && <div className="text-muted-foreground font-mono text-[11px]">{i.mac}</div>}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <AddressList addresses={i.addresses} />
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{i.mtu}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <div>{formatBytes(i.counters.rx_bytes)}</div>
                    <div className="text-muted-foreground text-xs">{formatNumber(i.counters.rx_packets)} pkts</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <div>{formatBytes(i.counters.tx_bytes)}</div>
                    <div className="text-muted-foreground text-xs">{formatNumber(i.counters.tx_packets)} pkts</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span className={i.counters.rx_errors + i.counters.tx_errors > 0 ? "text-destructive" : "text-muted-foreground"}>
                      {formatNumber(i.counters.rx_errors + i.counters.tx_errors)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={i.admin_up}
                        disabled={!canEdit || i.kind === "loopback" || toggling === i.name}
                        onCheckedChange={(v) => toggle(i, v)}
                        aria-label={`Ativar ${i.name}`}
                      />
                      {toggling === i.name && <Loader2Icon className="text-muted-foreground size-4 animate-spin" />}
                    </div>
                  </TableCell>
                  {canEdit && (
                    <TableCell>
                      <Button variant="ghost" size="icon" onClick={() => setEditing(i)} aria-label={`Editar ${i.name}`}>
                        <PencilIcon />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      <EditInterfaceDialog iface={editing} onClose={() => setEditing(null)} onSave={update} />
    </>
  )
}

function EditInterfaceDialog({
  iface,
  onClose,
  onSave,
}: {
  iface: RouterInterface | null
  onClose: () => void
  onSave: (name: string, body: InterfaceUpdate) => Promise<RouterInterface>
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!iface) return
    const form = new FormData(e.currentTarget)
    setPending(true)
    setError(null)
    try {
      await onSave(iface.name, {
        description: String(form.get("description") ?? ""),
        mtu: Number(form.get("mtu")),
      })
      toast.success(`${iface.name} atualizada`)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={!!iface} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit} key={iface?.name}>
          <DialogHeader>
            <DialogTitle>
              Editar <span className="font-mono">{iface?.name}</span>
            </DialogTitle>
            <DialogDescription>A mudança é aplicada imediatamente no roteador.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="description">Descrição</FieldLabel>
              <Input id="description" name="description" maxLength={64} defaultValue={iface?.description ?? ""} />
            </Field>
            <Field>
              <FieldLabel htmlFor="mtu">MTU</FieldLabel>
              <Input id="mtu" name="mtu" type="number" min={MTU_MIN} max={MTU_MAX} required defaultValue={iface?.mtu} />
              <FieldDescription>
                Entre {MTU_MIN} e {MTU_MAX}. O IPv6 exige no mínimo {MTU_MIN}.
              </FieldDescription>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancelar
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
