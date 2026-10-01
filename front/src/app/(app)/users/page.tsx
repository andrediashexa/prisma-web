"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { KeyRoundIcon, Loader2Icon, MoreHorizontalIcon, PlusIcon, Trash2Icon, UserCheckIcon, UserXIcon } from "lucide-react"

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
  DialogClose,
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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useMe } from "@/hooks/use-me"
import { api, errorMessage, fetcher } from "@/lib/api"
import { formatRelative } from "@/lib/format"
import { PASSWORD_MIN_LEN, ROLE_LABEL, type Role, type UserView } from "@/lib/types"

const ROLES: Role[] = ["admin", "operator", "viewer"]
const ROLE_HINT: Record<Role, string> = {
  admin: "Tudo, inclusive gerenciar usuários",
  operator: "Altera o roteador e vê o log",
  viewer: "Apenas visualiza",
}

type Dialogs =
  | { kind: "create" }
  | { kind: "password"; user: UserView }
  | { kind: "delete"; user: UserView }
  | null

export default function UsersPage() {
  const { data: me } = useMe()
  const { data, mutate } = useSWR<UserView[]>("/users", fetcher)
  const [dialog, setDialog] = useState<Dialogs>(null)

  async function patch(user: UserView, body: Record<string, unknown>, ok: string) {
    try {
      await api.patch(`/users/${user.id}`, body)
      await mutate()
      toast.success(ok)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <>
      <PageHeader title="Usuários" description="Contas locais com acesso a esta interface">
        <Button onClick={() => setDialog({ kind: "create" })}>
          <PlusIcon /> Novo usuário
        </Button>
      </PageHeader>

      <Card className="py-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Usuário</TableHead>
                <TableHead>Papel</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Último acesso</TableHead>
                <TableHead className="text-right">Sessões</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data && (
                <TableRow>
                  <TableCell colSpan={6} className="pl-4">
                    <Skeleton className="h-24 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {data?.map((u) => {
                const self = u.id === me?.id
                return (
                  <TableRow key={u.id}>
                    <TableCell className="pl-4 font-medium">
                      {u.username}
                      {self && <span className="text-muted-foreground ml-2 text-xs">(você)</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.role === "admin" ? "default" : "secondary"}>{ROLE_LABEL[u.role]}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {u.disabled ? <Badge variant="destructive">desativado</Badge> : <Badge variant="outline">ativo</Badge>}
                        {u.must_change_password && <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">senha provisória</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {u.last_login_at ? formatRelative(u.last_login_at) : "nunca"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{u.active_sessions}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Ações para ${u.username}`}>
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuLabel>Papel</DropdownMenuLabel>
                          <DropdownMenuRadioGroup
                            value={u.role}
                            onValueChange={(r) => r !== u.role && patch(u, { role: r }, `${u.username} agora é ${ROLE_LABEL[r as Role].toLowerCase()}`)}
                          >
                            {ROLES.map((r) => (
                              <DropdownMenuRadioItem key={r} value={r} disabled={self}>
                                {ROLE_LABEL[r]}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setDialog({ kind: "password", user: u })}>
                            <KeyRoundIcon /> Redefinir senha
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={self}
                            onSelect={() => patch(u, { disabled: !u.disabled }, `${u.username} ${u.disabled ? "reativado" : "desativado"}`)}
                          >
                            {u.disabled ? <UserCheckIcon /> : <UserXIcon />}
                            {u.disabled ? "Reativar" : "Desativar"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" disabled={self} onSelect={() => setDialog({ kind: "delete", user: u })}>
                            <Trash2Icon /> Excluir
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </Card>

      <CreateUserDialog open={dialog?.kind === "create"} onClose={() => setDialog(null)} onCreated={() => mutate()} />
      <ResetPasswordDialog user={dialog?.kind === "password" ? dialog.user : null} onClose={() => setDialog(null)} onDone={() => mutate()} />
      <AlertDialog open={dialog?.kind === "delete"} onOpenChange={(o) => !o && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir {dialog?.kind === "delete" && dialog.user.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              A conta e suas sessões são removidas. Os eventos dela no log de mudanças são mantidos.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (dialog?.kind !== "delete") return
                try {
                  await api.delete(`/users/${dialog.user.id}`)
                  toast.success(`${dialog.user.username} excluído`)
                  await mutate()
                } catch (err) {
                  toast.error(errorMessage(err))
                }
              }}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function CreateUserDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [role, setRole] = useState<Role>("viewer")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setPending(true)
    setError(null)
    try {
      await api.post("/users", { username: form.get("username"), password: form.get("password"), role })
      toast.success("Usuário criado")
      onCreated()
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Novo usuário</DialogTitle>
            <DialogDescription>A senha é provisória: o usuário precisa trocá-la no primeiro acesso.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="new-username">Usuário</FieldLabel>
              <Input id="new-username" name="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9._\-]+" autoComplete="off" />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-password">Senha provisória</FieldLabel>
              <Input id="new-password" name="password" type="password" required minLength={PASSWORD_MIN_LEN} autoComplete="new-password" />
              <FieldDescription>Mínimo de {PASSWORD_MIN_LEN} caracteres.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Papel</FieldLabel>
              <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABEL[r]} — <span className="text-muted-foreground">{ROLE_HINT[r]}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">Cancelar</Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              Criar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: UserView | null; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!user) return
    const form = new FormData(e.currentTarget)
    setPending(true)
    setError(null)
    try {
      await api.patch(`/users/${user.id}`, { password: form.get("password") })
      toast.success(`Senha de ${user.username} redefinida`)
      onDone()
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Redefinir senha de {user?.username}</DialogTitle>
            <DialogDescription>As sessões abertas dele serão encerradas e a troca será exigida no próximo acesso.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="reset-password">Nova senha provisória</FieldLabel>
              <Input id="reset-password" name="password" type="password" required minLength={PASSWORD_MIN_LEN} autoComplete="new-password" />
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">Cancelar</Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              Redefinir
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
