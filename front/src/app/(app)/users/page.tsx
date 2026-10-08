"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { KeyRoundIcon, Loader2Icon, MoreHorizontalIcon, PlusIcon, ServerCogIcon, Trash2Icon, UserCheckIcon, UserXIcon } from "lucide-react"

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
import { PASSWORD_MIN_LEN, ROLE_LABEL, type Role, type RouterAccess, type UserView } from "@/lib/types"

const ROLES: Role[] = ["admin", "operator", "viewer"]
const ROLE_HINT: Record<Role, string> = {
  admin: "Everything, including managing users",
  operator: "Changes the router and sees the log",
  viewer: "View only",
}

type Dialogs =
  | { kind: "create" }
  | { kind: "password"; user: UserView }
  | { kind: "delete"; user: UserView }
  | { kind: "access"; user: UserView }
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
      <PageHeader title="Users" description="Local accounts with access to this UI">
        <Button onClick={() => setDialog({ kind: "create" })}>
          <PlusIcon /> New user
        </Button>
      </PageHeader>

      <Card className="py-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Last login</TableHead>
                <TableHead className="hidden sm:table-cell text-right">Sessions</TableHead>
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
                      {self && <span className="text-muted-foreground ml-2 text-xs">(you)</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.role === "admin" ? "default" : "secondary"}>{ROLE_LABEL[u.role]}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {u.disabled ? <Badge variant="destructive">disabled</Badge> : <Badge variant="outline">active</Badge>}
                        {u.must_change_password && <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">temporary password</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">
                      {u.last_login_at ? formatRelative(u.last_login_at) : "never"}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-right tabular-nums">{u.active_sessions}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${u.username}`}>
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuLabel>Role</DropdownMenuLabel>
                          <DropdownMenuRadioGroup
                            value={u.role}
                            onValueChange={(r) => r !== u.role && patch(u, { role: r }, `${u.username}'s role changed to ${ROLE_LABEL[r as Role]}`)}
                          >
                            {ROLES.map((r) => (
                              <DropdownMenuRadioItem key={r} value={r} disabled={self}>
                                {ROLE_LABEL[r]}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setDialog({ kind: "password", user: u })}>
                            <KeyRoundIcon /> Reset password
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={u.role === "admin"} onSelect={() => setDialog({ kind: "access", user: u })}>
                            <ServerCogIcon /> Router access
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={self}
                            onSelect={() => patch(u, { disabled: !u.disabled }, `${u.username} ${u.disabled ? "re-enabled" : "disabled"}`)}
                          >
                            {u.disabled ? <UserCheckIcon /> : <UserXIcon />}
                            {u.disabled ? "Re-enable" : "Disable"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" disabled={self} onSelect={() => setDialog({ kind: "delete", user: u })}>
                            <Trash2Icon /> Delete
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
      <RouterAccessDialog user={dialog?.kind === "access" ? dialog.user : null} onClose={() => setDialog(null)} />
      <AlertDialog open={dialog?.kind === "delete"} onOpenChange={(o) => !o && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {dialog?.kind === "delete" && dialog.user.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              The account and its sessions are removed. Its events in the change log are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (dialog?.kind !== "delete") return
                try {
                  await api.delete(`/users/${dialog.user.id}`)
                  toast.success(`${dialog.user.username} deleted`)
                  await mutate()
                } catch (err) {
                  toast.error(errorMessage(err))
                }
              }}
            >
              Delete
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
      toast.success("User created")
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
            <DialogTitle>New user</DialogTitle>
            <DialogDescription>The password is temporary: the user must change it at first login.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="new-username">Username</FieldLabel>
              <Input id="new-username" name="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9._\-]+" autoComplete="off" />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-password">Temporary password</FieldLabel>
              <Input id="new-password" name="password" type="password" required minLength={PASSWORD_MIN_LEN} autoComplete="new-password" />
              <FieldDescription>At least {PASSWORD_MIN_LEN} characters.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Role</FieldLabel>
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
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              Create
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
      toast.success(`Password for ${user.username} reset`)
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
            <DialogTitle>Reset password for {user?.username}</DialogTitle>
            <DialogDescription>Their open sessions will be signed out and a password change will be required at next login.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="reset-password">New temporary password</FieldLabel>
              <Input id="reset-password" name="password" type="password" required minLength={PASSWORD_MIN_LEN} autoComplete="new-password" />
            </Field>
            {error && <FieldError>{error}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              Reset
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const DEFAULT_ACCESS = "default"
const ACCESS_CHOICES: { value: string; label: string }[] = [
  { value: "none", label: "No access" },
  { value: "viewer", label: ROLE_LABEL.viewer },
  { value: "operator", label: ROLE_LABEL.operator },
  { value: "admin", label: ROLE_LABEL.admin },
]

/**
 * A user's access router by router (#6): the global role applies unless
 * overridden here, up or down; "No access" hides the router from them.
 */
function RouterAccessDialog({ user, onClose }: { user: UserView | null; onClose: () => void }) {
  const key = user ? `/users/${user.id}/access` : null
  const { data, mutate } = useSWR<RouterAccess[]>(key, fetcher)
  const [saving, setSaving] = useState<string | null>(null)

  async function set(a: RouterAccess, value: string) {
    if (!user) return
    const role = value === DEFAULT_ACCESS ? null : value
    setSaving(a.router_id)
    try {
      await api.put(`/users/${user.id}/access/${a.router_id}`, { role })
      const label = role === null ? `the global role (${ROLE_LABEL[user.role]})` : (ACCESS_CHOICES.find((c) => c.value === role)?.label ?? role)
      toast.success(`${user.username} on ${a.router_name}: ${label}`)
      await mutate()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(null)
    }
  }

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Router access: {user?.username}</DialogTitle>
          <DialogDescription>
            {user && `${ROLE_LABEL[user.role]} on every router unless changed here.`} A router with no access disappears for this user,
            change log included. Router registration stays with administrators.
          </DialogDescription>
        </DialogHeader>
        {!data ? (
          <Skeleton className="h-24 w-full" />
        ) : data.length === 0 ? (
          <p className="text-muted-foreground text-sm">No routers registered.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {data.map((a) => (
              <div key={a.router_id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="truncate text-sm font-medium">{a.router_name}</span>
                <div className="flex items-center gap-2">
                  {saving === a.router_id && <Loader2Icon className="size-4 animate-spin" />}
                  <Select value={a.role ?? DEFAULT_ACCESS} onValueChange={(v) => set(a, v)} disabled={saving !== null}>
                    <SelectTrigger className="w-44" aria-label={`Access to ${a.router_name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={DEFAULT_ACCESS}>Global role{user ? ` (${ROLE_LABEL[user.role]})` : ""}</SelectItem>
                      {ACCESS_CHOICES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
