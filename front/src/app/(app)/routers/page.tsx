"use client"

import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"
import { CheckCircle2Icon, Loader2Icon, MoreHorizontalIcon, PencilIcon, PlugZapIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { PageHeader } from "@/components/page-header"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useMe } from "@/hooks/use-me"
import { useFleetStatus, useRouters } from "@/hooks/use-routers"
import { api, errorMessage } from "@/lib/api"
import { formatUptime } from "@/lib/format"
import { hasRole, type RouterView, type VersionInfo } from "@/lib/types"

type Dialogs = { kind: "edit"; router: RouterView | null } | { kind: "delete"; router: RouterView } | null

export default function RoutersPage() {
  const { data: me } = useMe()
  const { data: routers, mutate } = useRouters()
  const { data: fleet, mutate: mutateFleet } = useFleetStatus()
  const [dialog, setDialog] = useState<Dialogs>(null)
  const isAdmin = hasRole(me, "admin")

  const refresh = async () => {
    await Promise.all([mutate(), mutateFleet()])
  }

  return (
    <>
      <PageHeader title="Roteadores" description="Prismas gerenciados por esta interface, pela API gRPC de cada um.">
        {isAdmin && (
          <Button onClick={() => setDialog({ kind: "edit", router: null })}>
            <PlusIcon /> Cadastrar Prisma
          </Button>
        )}
      </PageHeader>

      <Card className="py-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Nome</TableHead>
                <TableHead>Endereço gRPC</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Versão</TableHead>
                <TableHead>Ligado há</TableHead>
                {isAdmin && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!routers && (
                <TableRow>
                  <TableCell colSpan={6} className="pl-4">
                    <Skeleton className="h-24 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {routers?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-10 text-center">
                    Nenhum Prisma cadastrado ainda.
                  </TableCell>
                </TableRow>
              )}
              {routers?.map((r) => {
                const s = fleet?.find((f) => f.id === r.id)
                return (
                  <TableRow key={r.id}>
                    <TableCell className="pl-4">
                      <Link href={`/routers/${r.id}`} className="font-medium hover:underline">
                        {r.name}
                      </Link>
                      {r.description && <div className="text-muted-foreground text-xs">{r.description}</div>}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{r.api_url}</span>
                    </TableCell>
                    <TableCell>
                      {!s ? (
                        <Skeleton className="h-5 w-16" />
                      ) : s.online ? (
                        <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300">
                          online · {s.latency_ms} ms
                        </Badge>
                      ) : (
                        <Badge variant="destructive" title={s.error ?? undefined}>
                          offline
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">{s?.version?.release ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-sm tabular-nums">
                      {s?.system ? formatUptime(s.system.uptime_seconds) : "—"}
                    </TableCell>
                    {isAdmin && (
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={`Ações para ${r.name}`}>
                              <MoreHorizontalIcon />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", router: r })}>
                              <PencilIcon /> Editar
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ kind: "delete", router: r })}>
                              <Trash2Icon /> Remover
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </Card>

      <RouterDialog
        open={dialog?.kind === "edit"}
        router={dialog?.kind === "edit" ? dialog.router : null}
        onClose={() => setDialog(null)}
        onSaved={refresh}
      />

      <AlertDialog open={dialog?.kind === "delete"} onOpenChange={(o) => !o && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover {dialog?.kind === "delete" && dialog.router.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              O prisma-web deixa de gerenciar este roteador. Nada é alterado no próprio Prisma, e o histórico dele no log
              de mudanças é mantido.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (dialog?.kind !== "delete") return
                try {
                  await api.delete(`/routers/${dialog.router.id}`)
                  toast.success(`${dialog.router.name} removido`)
                  await refresh()
                } catch (err) {
                  toast.error(errorMessage(err))
                }
              }}
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function RouterDialog({
  open,
  router,
  onClose,
  onSaved,
}: {
  open: boolean
  router: RouterView | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {/* key remonta o formulário ao trocar entre cadastrar/editar */}
        <RouterForm key={router?.id ?? "new"} router={router} onClose={onClose} onSaved={onSaved} />
      </DialogContent>
    </Dialog>
  )
}

function RouterForm({
  router,
  onClose,
  onSaved,
}: {
  router: RouterView | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(router?.name ?? "")
  const [url, setUrl] = useState(router?.api_url ?? "")
  const [description, setDescription] = useState(router?.description ?? "")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState<VersionInfo | null>(null)

  async function test() {
    setTesting(true)
    setError(null)
    setTested(null)
    try {
      const v = await api.post<VersionInfo>("/routers/test", { api_url: url })
      setTested(v)
      if (!name) setName(v.hostname)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setTesting(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      if (router) {
        await api.patch(`/routers/${router.id}`, { name, api_url: url, description })
        toast.success(`${name} atualizado`)
      } else {
        await api.post("/routers", { name, api_url: url, description })
        toast.success(`${name} cadastrado`)
      }
      await onSaved()
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{router ? `Editar ${router.name}` : "Cadastrar Prisma"}</DialogTitle>
        <DialogDescription>Endereço do servidor gRPC do Prisma (sem TLS por enquanto). IPv6 vai entre colchetes.</DialogDescription>
      </DialogHeader>
      <FieldGroup className="py-4">
        <Field>
          <FieldLabel htmlFor="r-url">Endereço da API</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="r-url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                setTested(null)
              }}
              placeholder="http://[2001:db8::1]:50051"
              className="font-mono"
              required
            />
            <Button type="button" variant="outline" onClick={test} disabled={!url || testing}>
              {testing ? <Loader2Icon className="animate-spin" /> : <PlugZapIcon />} Testar
            </Button>
          </div>
          {tested && (
            <FieldDescription className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2Icon className="size-4" /> Conectado: {tested.hostname} · Prisma {tested.release}
            </FieldDescription>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="r-name">Nome</FieldLabel>
          <Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={48} required placeholder="Matriz" />
        </Field>
        <Field>
          <FieldLabel htmlFor="r-desc">Descrição</FieldLabel>
          <Input id="r-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} placeholder="Opcional" />
        </Field>
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2Icon className="animate-spin" />}
          {router ? "Salvar" : "Cadastrar"}
        </Button>
      </DialogFooter>
    </form>
  )
}
