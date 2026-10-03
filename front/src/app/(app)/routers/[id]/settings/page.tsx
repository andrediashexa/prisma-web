"use client"

import { useParams, useSearchParams } from "next/navigation"
import { useMemo, useState } from "react"
import useSWR from "swr"
import { PencilIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react"

import { ChangeReview } from "@/components/config/change-review"
import { StagedChanges } from "@/components/config/staged-changes"
import { StatementForm } from "@/components/config/statement-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useConfigChanges, type ConfigChange } from "@/hooks/use-config-changes"
import { useRouterAccess, useRouterRole } from "@/hooks/use-routers"
import { fetcher } from "@/lib/api"
import {
  boxAllows,
  buildLine,
  describe,
  emptyForm,
  isNamed,
  stateFor,
  type FormState,
  type Grammar,
  type Instance,
  type Mode,
  type Statement,
} from "@/lib/config-model"
import { roleAtLeast, routerApi } from "@/lib/types"
import { cn } from "@/lib/utils"

/** A mode instance added in this session, before its first line exists on the box. */
interface Draft {
  mode: string
  path: string[]
}

const key = (path: string[]) => (path.length ? path.join(" > ") : "config")

/** A template path and a concrete one name the same modes (first keyword of each element). */
function sameHeads(template: string[], concrete: string[]) {
  return template.length === concrete.length && template.every((t, i) => t.split(" ")[0] === concrete[i].split(" ")[0])
}

export default function SettingsPage() {
  const { id } = useParams<{ id: string }>()
  const myRole = useRouterRole(id)
  const { access, readOnly } = useRouterAccess(id)
  const { data: grammar } = useSWR<Grammar>(routerApi(id, "/config/grammar"), fetcher, { revalidateOnFocus: false })
  const { data: tree, mutate } = useSWR<{ revision: string; instances: Instance[] }>(routerApi(id, "/config/tree"), fetcher)
  // `?at=interface wan0` opens that instance (the Interfaces page links here, #40).
  const at = useSearchParams().get("at")
  const [selected, setSelected] = useState(at ?? "config")
  const cc = useConfigChanges(id)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [editing, setEditing] = useState<{ statement: Statement; path: string[]; form: FormState; old?: string } | null>(null)
  const [adding, setAdding] = useState<{ path: string[]; mode: Mode } | null>(null)
  const [creating, setCreating] = useState<{ mode: Mode; parent: string[] } | null>(null)
  const [filter, setFilter] = useState("")

  const modes = useMemo(() => new Map((grammar?.modes ?? []).map((m) => [m.key, m])), [grammar])
  const instances = useMemo(() => {
    const all = [...(tree?.instances ?? [])]
    for (const d of drafts) if (!all.some((i) => key(i.path) === key(d.path))) all.push({ mode: d.mode, path: d.path, lines: [] })
    return all
  }, [tree, drafts])

  if (!grammar || !tree) return <Skeleton className="h-96 w-full rounded-xl" />

  const current = instances.find((i) => key(i.path) === selected) ?? instances[0]
  const mode = modes.get(current.mode)!
  const canChange = (m: Mode) => roleAtLeast(myRole, "operator") && !readOnly && boxAllows(access, m)
  const editable = canChange(mode)
  // Modes entered from this one: same path so far, one element more.
  const under = grammar.modes.filter((m) => m.path.length === current.path.length + 1 && sameHeads(m.path.slice(0, -1), current.path))
  // A named one (an interface, a pool) can always be added; an unnamed one once.
  const children = under.filter((m) => isNamed(m) || !instances.some((i) => i.mode === m.key && sameHeads(i.path.slice(0, -1), current.path)))
  // Statements that enter a child mode (`pool <pool>`) are reached by adding the child, not as settings.
  const entering = new Set(under.map((m) => m.path.at(-1)!.split(" ")[0]))
  const statements = mode.groups.flatMap((g) => g.statements.map((s) => ({ s, group: g.title })))
  const addable = statements.filter(({ s }) => !s.syntax.startsWith("no ") && !entering.has(s.syntax.split(" ")[0]))
  const parent = instances.find((i) => key(i.path) === key(current.path.slice(0, -1)))
  const parentMode = parent && modes.get(parent.mode)
  const removable =
    current.path.length > 0 &&
    !!parentMode?.groups.some((g) => g.statements.some((s) => s.syntax.startsWith(`no ${current.path.at(-1)!.split(" ")[0]} `)))

  const stage = (e: ConfigChange) => cc.stage(e)

  // Navigation: the top level, then every instance under its mode's title.
  const nav = new Map<string, Instance[]>()
  for (const i of instances) {
    const m = modes.get(i.mode)!
    if (filter && !`${m.title} ${i.path.join(" ")}`.toLowerCase().includes(filter.toLowerCase())) continue
    nav.set(m.title, [...(nav.get(m.title) ?? []), i])
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>Every part of the configuration, read from revision {tree.revision}.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <SearchIcon className="text-muted-foreground absolute top-2.5 left-2 size-4" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="pl-8" />
          </div>
          <nav className="max-h-[60vh] space-y-3 overflow-y-auto text-sm">
            {[...nav.entries()].map(([title, list]) => (
              <div key={title}>
                <div className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">{title}</div>
                {list.map((i) => (
                  <button
                    key={key(i.path)}
                    onClick={() => setSelected(key(i.path))}
                    className={cn(
                      "hover:bg-accent block w-full truncate rounded px-2 py-1 text-left font-mono text-xs",
                      key(i.path) === key(current.path) && "bg-accent font-medium",
                    )}
                  >
                    {i.path.at(-1) ?? "top level"}
                    {drafts.some((d) => key(d.path) === key(i.path)) && <Badge variant="outline" className="ml-2">new</Badge>}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </CardContent>
      </Card>

      <div className="grid min-w-0 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="font-mono">{current.path.length ? current.path.join(" › ") : "Top level"}</CardTitle>
            <CardDescription>
              {mode.title} · changed by {mode.roles.join(", ")}
              {!editable && " · read-only for you"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {current.lines.length === 0 && <p className="text-muted-foreground text-sm">Nothing set here yet.</p>}
            {current.lines.map((l) => {
              const st = l.statement ? mode.groups[l.statement[0]].statements[l.statement[1]] : null
              return (
                <div key={l.text} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
                  <span className="font-mono text-sm">{l.text}</span>
                  {!st && (
                    <Badge variant="outline" title="Not in the VTY's grammar: owned by the box, shown read-only.">
                      read-only
                    </Badge>
                  )}
                  {st && editable && (
                    <span className="ml-auto flex gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        aria-label={`Edit ${l.text}`}
                        onClick={() => setEditing({ statement: st, path: current.path, form: stateFor(st.tokens, l.text, l.values), old: l.text })}
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        aria-label={`Remove ${l.text}`}
                        onClick={() => stage({ path: current.path, lines: [`no ${l.text}`], label: `remove ${l.text}` })}
                      >
                        <Trash2Icon />
                      </Button>
                    </span>
                  )}
                </div>
              )
            })}
            {editable && (
              <div className="flex flex-wrap gap-2 pt-2">
                <Button variant="outline" size="sm" onClick={() => setAdding({ path: current.path, mode })}>
                  <PlusIcon /> Add a setting
                </Button>
                {children.filter(canChange).map((m) => (
                  <Button
                    key={m.key}
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (isNamed(m)) return setCreating({ mode: m, parent: current.path })
                      // Nothing to name (`system > memory`): open it to add its settings.
                      const path = [...current.path, m.path.at(-1)!]
                      setDrafts((d) => [...d, { mode: m.key, path }])
                      setSelected(key(path))
                    }}
                  >
                    <PlusIcon /> Add {m.path.at(-1)!.split(" ")[0]}
                  </Button>
                ))}
                {removable && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => stage({ path: current.path.slice(0, -1), lines: [`no ${current.path.at(-1)}`], label: `remove ${current.path.at(-1)}` })}
                  >
                    <Trash2Icon /> Remove {current.path.at(-1)}
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <StagedChanges cc={cc} />
      </div>

      <AddDialog
        target={adding}
        statements={addable}
        onClose={() => setAdding(null)}
        onPick={(s) => {
          const path = adding!.path
          setAdding(null)
          setEditing({ statement: s, path, form: emptyForm() })
        }}
      />
      <StatementDialog
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={(line) => {
          const e = editing!
          stage({ path: e.path, lines: e.old ? [`no ${e.old}`, line] : [line], label: e.old ? `${e.old} → ${line}` : line })
          setEditing(null)
        }}
      />
      <CreateDialog
        creating={creating}
        onClose={() => setCreating(null)}
        onCreate={(element) => {
          const c = creating!
          const path = [...c.parent, element]
          setDrafts((d) => [...d, { mode: c.mode.key, path }])
          setSelected(key(path))
          setCreating(null)
        }}
      />
      <ChangeReview
        routerId={id}
        candidateId={cc.candidateId}
        title="Apply settings"
        onClose={cc.closeReview}
        onStale={cc.reopen}
        onCommitted={() => {
          cc.committed()
          setDrafts([])
          void mutate()
        }}
      />
    </div>
  )
}

function AddDialog({
  target,
  statements,
  onClose,
  onPick,
}: {
  target: { path: string[]; mode: Mode } | null
  statements: { s: Statement; group: string }[]
  onClose: () => void
  onPick: (s: Statement) => void
}) {
  const [q, setQ] = useState("")
  const shown = statements.filter(({ s }) => s.syntax.toLowerCase().includes(q.toLowerCase()))
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a setting</DialogTitle>
          <DialogDescription>{target?.mode.title}: what the VTY takes here.</DialogDescription>
        </DialogHeader>
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search, e.g. mtu, neighbor, timeout" />
        <div className="max-h-[50vh] space-y-1 overflow-y-auto">
          {shown.map(({ s, group }) => (
            <button key={`${group}-${s.syntax}`} onClick={() => onPick(s)} className="hover:bg-accent block w-full rounded px-2 py-1.5 text-left">
              <span className="font-mono text-sm">{s.syntax}</span>
              {group !== target?.mode.title && <span className="text-muted-foreground ml-2 text-xs">{group}</span>}
            </button>
          ))}
          {shown.length === 0 && <p className="text-muted-foreground p-2 text-sm">No setting matches.</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StatementDialog({
  editing,
  onClose,
  onSave,
}: {
  editing: { statement: Statement; form: FormState; old?: string } | null
  onClose: () => void
  onSave: (line: string) => void
}) {
  const [form, setForm] = useState<FormState | null>(null)
  const [shownFor, setShownFor] = useState<typeof editing>(null)
  if (editing !== shownFor) {
    setShownFor(editing)
    setForm(editing?.form ?? null)
  }
  const built = editing && form ? buildLine(editing.statement.tokens, form) : null
  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editing?.old ? "Change a setting" : "New setting"}</DialogTitle>
          <DialogDescription className="font-mono">{editing && describe(editing.statement.tokens)}</DialogDescription>
        </DialogHeader>
        {editing && form && <StatementForm tokens={editing.statement.tokens} state={form} onChange={setForm} />}
        {built && (
          <p
            className={cn(
              "rounded-md border px-3 py-2 font-mono text-sm",
              // Nothing typed yet is not an error, only what is still missing.
              "error" in built && (built.error.endsWith("required") ? "text-muted-foreground" : "text-destructive"),
            )}
          >
            {"error" in built ? (built.error.endsWith("required") ? `fill in ${built.error.replace(/: required$/, "")}` : built.error) : built.line}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!built || "error" in built} onClick={() => built && "line" in built && onSave(built.line)}>
            Add to the changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateDialog({
  creating,
  onClose,
  onCreate,
}: {
  creating: { mode: Mode } | null
  onClose: () => void
  onCreate: (element: string) => void
}) {
  const [form, setForm] = useState<FormState>(emptyForm())
  const [shownFor, setShownFor] = useState<typeof creating>(null)
  if (creating !== shownFor) {
    setShownFor(creating)
    setForm(emptyForm())
  }
  const tokens = creating?.mode.path_tokens.at(-1) ?? []
  const built = creating ? buildLine(tokens, form) : null
  return (
    <Dialog open={!!creating} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add {creating?.mode.title}</DialogTitle>
          <DialogDescription>
            Name it; then add its settings. It reaches the router with them, after the review.
          </DialogDescription>
        </DialogHeader>
        {creating && <StatementForm tokens={tokens} state={form} onChange={setForm} />}
        {built && "error" in built && <p className="text-muted-foreground text-sm">{built.error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!built || "error" in built} onClick={() => built && "line" in built && onCreate(built.line)}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

