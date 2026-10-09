"use client"

import { useState } from "react"
import { PlusIcon, Trash2Icon, Undo2Icon, XIcon } from "lucide-react"

import { usePolicies } from "@/components/policies/policies-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { isListName, memberError, usedBy, type ListKind } from "@/lib/policy-lists"
import { cn } from "@/lib/utils"

const EXAMPLE: Record<ListKind, string> = {
  "prefix-list": "198.51.100.0/24",
  community: "65000:100",
  "large-community": "65000:1:100",
  "extended-community": "rt:65000:100",
}

/**
 * policy-options' lists of a kind (#89): each with its members and the policies that name it; an
 * administrator of the box adds and removes members and lists, staged for the review.
 */
export function ListsCard({ kind, title, description }: { kind: ListKind; title: string; description: string }) {
  const { lists, policies, editable, namesOf, stageMembers } = usePolicies()
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState<{ name: string; users: string[] } | null>(null)
  const names = lists ? namesOf(kind) : []

  const remove = (name: string) => {
    const users = usedBy(policies, kind, name)
    if (users.length) setRemoving({ name, users })
    else stageMembers(kind, name, [], `remove ${kind} ${name}`)
  }

  return (
    <Card className="py-0" data-lists={kind}>
      <CardHeader className="pt-6">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        {editable && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              <PlusIcon /> New {kind}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      {lists === undefined ? (
        <CardContent className="pb-6">
          <Skeleton className="h-16 w-full" />
        </CardContent>
      ) : names.length === 0 ? (
        <CardContent className="text-muted-foreground pb-6 text-sm">None configured.</CardContent>
      ) : (
        <div className="overflow-x-auto pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Members</TableHead>
                <TableHead className="hidden sm:table-cell">Used by</TableHead>
                {editable && <TableHead className="pr-6" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {names.map((name) => (
                <ListRow key={name} kind={kind} name={name} onRemove={() => remove(name)} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <NewListDialog kind={kind} open={creating} taken={names} onClose={() => setCreating(false)} />
      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Remove {kind} {removing?.name}?
            </DialogTitle>
            <DialogDescription>
              {removing?.users.join(", ")} {removing?.users.length === 1 ? "names" : "name"} it: the commit may be refused, or the policy match
              nothing where it did. Take it out of the {removing?.users.length === 1 ? "policy" : "policies"} first, or remove it anyway.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing) stageMembers(kind, removing.name, [], `remove ${kind} ${removing.name}`)
                setRemoving(null)
              }}
            >
              Remove anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function ListRow({ kind, name, onRemove }: { kind: ListKind; name: string; onRemove: () => void }) {
  const { policies, editable, membersOf, runningOf, isStaged, stageMembers } = usePolicies()
  const [draft, setDraft] = useState("")
  const members = membersOf(kind, name)
  const staged = isStaged(kind, name)
  const gone = members === null
  const users = usedBy(policies, kind, name)
  const error = draft.trim() ? (memberError(kind, draft) ?? (members?.includes(draft.trim()) ? "already a member" : null)) : null
  const add = () => {
    if (!draft.trim() || error || !members) return
    stageMembers(kind, name, [...members, draft.trim()], `${kind} ${name}: add ${draft.trim()}`)
    setDraft("")
  }

  return (
    <TableRow data-list={name} className={cn("align-top", gone && "opacity-60")}>
      <TableCell className="pl-6">
        <span className={cn("font-mono font-medium", gone && "line-through")}>{name}</span>
        {staged && (
          <Badge variant="outline" className="ml-2 border-amber-500/40 text-amber-700 dark:text-amber-300">
            {gone ? "to be removed" : "staged"}
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {(members ?? []).map((m) => (
            <Badge key={m} variant="secondary" className="gap-1 font-mono" data-member={m}>
              {m}
              {editable && (
                <button
                  type="button"
                  aria-label={`Remove ${m} from ${name}`}
                  className="hover:text-destructive -mr-1 rounded-sm"
                  onClick={() => stageMembers(kind, name, members!.filter((x) => x !== m), `${kind} ${name}: remove ${m}`)}
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
        {editable && !gone && (
          <form
            className="mt-2 flex max-w-sm items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              add()
            }}
          >
            <div className="min-w-0 flex-1">
              <Input
                aria-label={`New member of ${name}`}
                placeholder={EXAMPLE[kind]}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="h-8 font-mono text-xs"
                aria-invalid={!!error}
              />
              {error && <p className="text-destructive mt-1 text-xs">{error}</p>}
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={!draft.trim() || !!error} aria-label={`Add to ${name}`}>
              <PlusIcon /> Add
            </Button>
          </form>
        )}
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        {users.length ? (
          <div className="flex flex-wrap gap-1" data-used-by>
            {users.map((u) => (
              <Badge key={u} variant="outline" className="font-mono">
                {u}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">no policy</span>
        )}
      </TableCell>
      {editable && (
        <TableCell className="pr-6 text-right">
          {gone ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Keep ${kind} ${name}`}
              onClick={() => stageMembers(kind, name, runningOf(kind, name) ?? [], "")}
            >
              <Undo2Icon /> Keep
            </Button>
          ) : (
            <Button variant="ghost" size="icon" aria-label={`Remove ${kind} ${name}`} onClick={onRemove}>
              <Trash2Icon />
            </Button>
          )}
        </TableCell>
      )}
    </TableRow>
  )
}

function NewListDialog({ kind, open, taken, onClose }: { kind: ListKind; open: boolean; taken: string[]; onClose: () => void }) {
  const { stageMembers } = usePolicies()
  const [name, setName] = useState("")
  const [text, setText] = useState("")
  const members = [...new Set(text.split(/[\s,]+/).filter(Boolean))]
  const nameError = !name ? null : !isListName(name) ? "one word: letters, digits, - _ . :" : taken.includes(name) ? `${kind} ${name} exists` : null
  const bad = members.map((m) => [m, memberError(kind, m)] as const).find(([, e]) => e)
  const close = () => {
    setName("")
    setText("")
    onClose()
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!name || nameError || bad || members.length === 0) return
            stageMembers(kind, name, members, `new ${kind} ${name}`)
            close()
          }}
        >
          <DialogHeader>
            <DialogTitle>New {kind}</DialogTitle>
            <DialogDescription>Under policy-options; a policy matches on it by its name.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Field data-invalid={!!nameError}>
              <FieldLabel htmlFor={`new-${kind}-name`}>Name</FieldLabel>
              <Input id={`new-${kind}-name`} value={name} onChange={(e) => setName(e.target.value.trim())} className="font-mono" autoFocus />
              {nameError && <FieldError>{nameError}</FieldError>}
            </Field>
            <Field data-invalid={!!bad}>
              <FieldLabel htmlFor={`new-${kind}-members`}>Members</FieldLabel>
              <Textarea id={`new-${kind}-members`} value={text} onChange={(e) => setText(e.target.value)} className="font-mono" rows={4} placeholder={EXAMPLE[kind]} />
              <FieldDescription>One per line, or separated by spaces.</FieldDescription>
              {bad && <FieldError>{`${bad[0]}: ${bad[1]}`}</FieldError>}
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name || !!nameError || !!bad || members.length === 0}>
              Add to the changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
