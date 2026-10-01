"use client"

import { useParams } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { FilePenLineIcon, HardDriveDownloadIcon, HistoryIcon, Loader2Icon, PlayIcon, RotateCcwIcon, Trash2Icon } from "lucide-react"

import { ChangeReview, discardCandidate } from "@/components/config/change-review"
import { DiagnosticsList } from "@/components/config/diagnostics"
import { ConfigView } from "@/components/config/diff-view"
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
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useMe } from "@/hooks/use-me"
import { useRouterAccess } from "@/hooks/use-routers"
import { api, ApiError, errorMessage, fetcher } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import {
  hasRole,
  routerApi,
  type ConfigText,
  type Diagnostic,
  type EditResponse,
  type OpenCandidateResponse,
  type Revision,
} from "@/lib/types"
import { parsePath } from "@/lib/vty"

interface AppliedEdit {
  path: string[]
  lines: string[]
  diagnostics: Diagnostic[]
}

export default function ConfigPage() {
  const { id } = useParams<{ id: string }>()
  const { data: me } = useMe()
  const { readOnly } = useRouterAccess(id)
  const canEdit = hasRole(me, "operator") && !readOnly
  const { data: running, mutate: mutateRunning } = useSWR<ConfigText>(routerApi(id, "/config/running"), fetcher)
  const { data: revs } = useSWR<{ revisions: Revision[] }>(routerApi(id, "/config/revisions"), fetcher)
  const [candidate, setCandidate] = useState<OpenCandidateResponse | null>(null)
  const [opening, setOpening] = useState(false)
  const [saving, setSaving] = useState(false)
  const [askSave, setAskSave] = useState(false)
  /** Edits carried over from an expired candidate into its replacement (#11). */
  const [carried, setCarried] = useState<AppliedEdit[]>([])

  // Don't leave an orphan candidate on Prisma when leaving the page.
  const open = useRef<string | null>(null)
  useEffect(() => {
    open.current = candidate?.candidate_id ?? null
  }, [candidate])
  useEffect(
    () => () => {
      if (open.current) void discardCandidate(id, open.current)
    },
    [id],
  )

  async function openCandidate(fromRevision?: number) {
    setOpening(true)
    try {
      const c = await api.post<OpenCandidateResponse>(
        routerApi(id, "/config/candidates"),
        fromRevision === undefined ? {} : { from_revision: fromRevision },
      )
      setCandidate(c)
      if (fromRevision !== undefined) toast.info(`Revision ${fromRevision} loaded into the candidate. Review and apply it to roll back to it.`)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setOpening(false)
    }
  }

  /** Prisma closed an idle candidate: open a new one and apply the same lines again, in order. */
  async function reopen(edits: AppliedEdit[]) {
    const c = await api.post<OpenCandidateResponse>(routerApi(id, "/config/candidates"), {})
    const redone: AppliedEdit[] = []
    try {
      for (const e of edits) {
        const r = await api.post<EditResponse>(routerApi(id, `/config/candidates/${c.candidate_id}/edit`), { path: e.path, lines: e.lines })
        redone.push({ ...e, diagnostics: r.diagnostics })
      }
      if (edits.length) toast.success(`New candidate opened and ${edits.length} edit(s) applied again.`)
    } catch (err) {
      // The running configuration may have moved on since: the rest is left for the user to redo.
      toast.error(`Applied ${redone.length} of ${edits.length} edit(s) again: ${errorMessage(err)}`)
    }
    setCarried(redone)
    setCandidate(c)
  }

  async function save() {
    setSaving(true)
    try {
      const r = await api.post<{ output: string }>(routerApi(id, "/config/save"))
      toast.success(r.output || "Configuration saved")
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  if (candidate) {
    return (
      <CandidateEditor
        key={candidate.candidate_id}
        routerId={id}
        candidate={candidate}
        initialApplied={carried}
        onReopen={reopen}
        onDone={async (committed) => {
          if (!committed) await discardCandidate(id, candidate.candidate_id)
          setCandidate(null)
          setCarried([])
          await mutateRunning()
        }}
      />
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          Running configuration
          {running && <Badge variant="outline" className="font-mono">{running.revision}</Badge>}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setAskSave(true)} disabled={saving}>
              {saving ? <Loader2Icon className="animate-spin" /> : <HardDriveDownloadIcon />} Save for boot
            </Button>
            <Button onClick={() => openCandidate()} disabled={opening}>
              {opening ? <Loader2Icon className="animate-spin" /> : <FilePenLineIcon />} New change
            </Button>
          </div>
        )}
      </div>

      <Tabs defaultValue="running">
        <TabsList>
          <TabsTrigger value="running">Running</TabsTrigger>
          <TabsTrigger value="revisions">
            <HistoryIcon /> Revisions {revs && `(${revs.revisions.length})`}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="running" className="mt-4">
          {running ? <ConfigView text={running.text} className="max-h-[70vh]" /> : <Skeleton className="h-96 w-full" />}
        </TabsContent>
        <TabsContent value="revisions" className="mt-4">
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16 pl-4">#</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Comment</TableHead>
                  {canEdit && <TableHead className="w-40" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {!revs && (
                  <TableRow>
                    <TableCell colSpan={4}>
                      <Skeleton className="h-24 w-full" />
                    </TableCell>
                  </TableRow>
                )}
                {revs?.revisions.map((r) => (
                  <TableRow key={r.number}>
                    <TableCell className="pl-4 font-mono">{r.number}</TableCell>
                    <TableCell className="tabular-nums">{r.committed_at ? formatDateTime(r.committed_at) : "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.comment || "—"}</TableCell>
                    {canEdit && (
                      <TableCell className="text-right">
                        {r.number > 0 && (
                          <Button variant="ghost" size="sm" onClick={() => openCandidate(r.number)} disabled={opening}>
                            Roll back to this
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>

      <AlertDialog open={askSave} onOpenChange={setAskSave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save the running configuration?</AlertDialogTitle>
            <AlertDialogDescription>
              Writes the current configuration to the file Prisma loads at boot (<span className="font-mono">save</span>).
              Without this, applied changes are lost on the next reboot.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={save}>Save</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function isExpired(err: unknown) {
  return err instanceof ApiError && err.code === "candidate_expired"
}

function CandidateEditor({
  routerId,
  candidate,
  initialApplied,
  onReopen,
  onDone,
}: {
  routerId: string
  candidate: OpenCandidateResponse
  initialApplied: AppliedEdit[]
  onReopen: (edits: AppliedEdit[]) => Promise<void>
  onDone: (committed: boolean) => Promise<void>
}) {
  const base = routerApi(routerId, `/config/candidates/${candidate.candidate_id}`)
  const { data: text, mutate, error: textError } = useSWR<{ text: string }>(base, fetcher, { fallbackData: { text: candidate.text } })
  const [path, setPath] = useState("")
  const [lines, setLines] = useState("")
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState<AppliedEdit[]>(initialApplied)
  const [expiredNow, setExpiredNow] = useState(false)
  const [reopening, setReopening] = useState(false)
  const expired = expiredNow || isExpired(textError)
  const [refusal, setRefusal] = useState<{ message: string; items: Diagnostic[] } | null>(null)
  const [reviewing, setReviewing] = useState(false)

  async function apply(e: React.FormEvent) {
    e.preventDefault()
    const body = { path: parsePath(path), lines: lines.split("\n").filter((l) => l.trim()) }
    if (body.lines.length === 0) return
    setApplying(true)
    setRefusal(null)
    try {
      const r = await api.post<EditResponse>(`${base}/edit`, body)
      setApplied((a) => [...a, { ...body, diagnostics: r.diagnostics }])
      setLines("")
    } catch (err) {
      if (isExpired(err)) {
        setExpiredNow(true)
        return
      }
      setRefusal({
        message: err instanceof Error ? err.message : "Rejected",
        items: err instanceof ApiError ? (err.diagnostics?.items ?? []) : [],
      })
    } finally {
      // Lines before the rejected one stay applied, so the text changes even on error.
      await mutate()
      setApplying(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="secondary">Candidate open</Badge>
          <span className="text-muted-foreground">
            based on revision <span className="font-mono">{candidate.base_revision}</span>. Nothing changes on the router until you apply.
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => onDone(false)}>
            <Trash2Icon /> Discard
          </Button>
          <Button onClick={() => setReviewing(true)} disabled={expired}>
            <PlayIcon /> Review and apply
          </Button>
        </div>
      </div>

      {expired && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          <span>
            This change sat idle for over 25 minutes and Prisma closed it. Nothing was applied to the router.
            {applied.length > 0 && ` Your ${applied.length} edit(s) can be applied again on a new candidate.`}
          </span>
          <Button
            size="sm"
            disabled={reopening}
            onClick={async () => {
              setReopening(true)
              try {
                await onReopen(applied)
              } catch (err) {
                toast.error(errorMessage(err))
                setReopening(false)
              }
            }}
          >
            {reopening ? <Loader2Icon className="animate-spin" /> : <RotateCcwIcon />} Reopen{applied.length > 0 && " and apply again"}
          </Button>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Edit</CardTitle>
            <CardDescription>Lines are applied as if typed at the prompt, at the given level.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={apply} className="space-y-4">
              <Field>
                <FieldLabel htmlFor="edit-path">Level</FieldLabel>
                <Input
                  id="edit-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="nat / cgnat / pool RFC6598"
                  className="font-mono"
                />
                <FieldDescription>Empty means top level. Separate levels with “/”.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-lines">Lines</FieldLabel>
                <Textarea
                  id="edit-lines"
                  value={lines}
                  onChange={(e) => setLines(e.target.value)}
                  placeholder={"block-size 512\nno shutdown"}
                  rows={6}
                  className="font-mono text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) apply(e)
                  }}
                />
                <FieldDescription>One per line. Ctrl+Enter applies.</FieldDescription>
              </Field>
              {refusal && (
                // Lines before the rejected one remain applied (VTY rule).
                <div className="border-destructive/40 bg-destructive/5 space-y-2 rounded-lg border p-3">
                  <p className="text-destructive text-sm font-medium">The VTY rejected the change</p>
                  {refusal.items.length > 0 ? (
                    <DiagnosticsList items={refusal.items} />
                  ) : (
                    <p className="text-destructive text-sm">{refusal.message}</p>
                  )}
                </div>
              )}
              <Button type="submit" disabled={applying || !lines.trim()}>
                {applying && <Loader2Icon className="animate-spin" />}
                Apply to candidate
              </Button>
            </form>

            {applied.length > 0 && (
              <div className="mt-6 space-y-3">
                <h3 className="text-sm font-medium">Applied to this candidate</h3>
                <ol className="space-y-2">
                  {applied.map((a, i) => (
                    <li key={i} className="bg-muted/50 rounded-md border p-2 font-mono text-xs">
                      <div className="text-muted-foreground">{a.path.length ? a.path.join(" › ") : "(top)"}</div>
                      {a.lines.map((l, j) => (
                        <div key={j}>{l}</div>
                      ))}
                      {a.diagnostics.length > 0 && <DiagnosticsList items={a.diagnostics} className="mt-2 font-sans" />}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Candidate</CardTitle>
            <CardDescription>What show running-config will look like after the commit</CardDescription>
            <CardAction>
              <Badge variant="outline" className="font-mono">
                {candidate.candidate_id.slice(0, 8)}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <ConfigView text={text?.text ?? ""} className="max-h-[65vh]" />
          </CardContent>
        </Card>
      </div>

      <ChangeReview
        routerId={routerId}
        candidateId={reviewing ? candidate.candidate_id : null}
        title="Apply change"
        keepCandidateOnCancel
        onClose={() => setReviewing(false)}
        onCommitted={() => void onDone(true)}
      />
    </>
  )
}
