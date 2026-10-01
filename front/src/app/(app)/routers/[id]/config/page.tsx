"use client"

import { useParams } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { FilePenLineIcon, HardDriveDownloadIcon, HistoryIcon, Loader2Icon, PlayIcon, Trash2Icon } from "lucide-react"

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
  const canEdit = hasRole(me, "operator")
  const { data: running, mutate: mutateRunning } = useSWR<ConfigText>(routerApi(id, "/config/running"), fetcher)
  const { data: revs } = useSWR<{ revisions: Revision[] }>(routerApi(id, "/config/revisions"), fetcher)
  const [candidate, setCandidate] = useState<OpenCandidateResponse | null>(null)
  const [opening, setOpening] = useState(false)
  const [saving, setSaving] = useState(false)
  const [askSave, setAskSave] = useState(false)

  // Não deixa candidate órfão no Prisma ao sair da página.
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
      if (fromRevision !== undefined) toast.info(`Revisão ${fromRevision} carregada no candidate. Revise e aplique para voltar a ela.`)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setOpening(false)
    }
  }

  async function save() {
    setSaving(true)
    try {
      const r = await api.post<{ output: string }>(routerApi(id, "/config/save"))
      toast.success(r.output || "Configuração salva")
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  if (candidate) {
    return (
      <CandidateEditor
        routerId={id}
        candidate={candidate}
        onDone={async (committed) => {
          if (!committed) await discardCandidate(id, candidate.candidate_id)
          setCandidate(null)
          await mutateRunning()
        }}
      />
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          Configuração em uso
          {running && <Badge variant="outline" className="font-mono">{running.revision}</Badge>}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setAskSave(true)} disabled={saving}>
              {saving ? <Loader2Icon className="animate-spin" /> : <HardDriveDownloadIcon />} Salvar para o boot
            </Button>
            <Button onClick={() => openCandidate()} disabled={opening}>
              {opening ? <Loader2Icon className="animate-spin" /> : <FilePenLineIcon />} Nova alteração
            </Button>
          </div>
        )}
      </div>

      <Tabs defaultValue="running">
        <TabsList>
          <TabsTrigger value="running">Em uso</TabsTrigger>
          <TabsTrigger value="revisions">
            <HistoryIcon /> Revisões {revs && `(${revs.revisions.length})`}
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
                  <TableHead>Quando</TableHead>
                  <TableHead>Comentário</TableHead>
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
                            Voltar a esta
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
            <AlertDialogTitle>Salvar a configuração em uso?</AlertDialogTitle>
            <AlertDialogDescription>
              Grava a configuração atual no arquivo que o Prisma carrega ao ligar (<span className="font-mono">save</span>).
              Sem isso, as mudanças aplicadas se perdem no próximo reboot.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={save}>Salvar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function CandidateEditor({
  routerId,
  candidate,
  onDone,
}: {
  routerId: string
  candidate: OpenCandidateResponse
  onDone: (committed: boolean) => Promise<void>
}) {
  const base = routerApi(routerId, `/config/candidates/${candidate.candidate_id}`)
  const { data: text, mutate } = useSWR<{ text: string }>(base, fetcher, { fallbackData: { text: candidate.text } })
  const [path, setPath] = useState("")
  const [lines, setLines] = useState("")
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState<AppliedEdit[]>([])
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
      setRefusal({
        message: err instanceof Error ? err.message : "Recusado",
        items: err instanceof ApiError ? (err.diagnostics?.items ?? []) : [],
      })
    } finally {
      // Linhas antes da recusada ficam aplicadas, então o texto muda mesmo com erro.
      await mutate()
      setApplying(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="secondary">Candidate aberto</Badge>
          <span className="text-muted-foreground">
            sobre a revisão <span className="font-mono">{candidate.base_revision}</span>. Nada muda no roteador até você aplicar.
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => onDone(false)}>
            <Trash2Icon /> Descartar
          </Button>
          <Button onClick={() => setReviewing(true)}>
            <PlayIcon /> Revisar e aplicar
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Editar</CardTitle>
            <CardDescription>As linhas são aplicadas como se digitadas no prompt, no nível indicado.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={apply} className="space-y-4">
              <Field>
                <FieldLabel htmlFor="edit-path">Nível</FieldLabel>
                <Input
                  id="edit-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="nat / cgnat / pool RFC6598"
                  className="font-mono"
                />
                <FieldDescription>Vazio é o topo. Separe os níveis com “/”.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-lines">Linhas</FieldLabel>
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
                <FieldDescription>Uma por linha. Ctrl+Enter aplica.</FieldDescription>
              </Field>
              {refusal && (
                // As linhas antes da recusada continuam aplicadas (regra do VTY).
                <div className="border-destructive/40 bg-destructive/5 space-y-2 rounded-lg border p-3">
                  <p className="text-destructive text-sm font-medium">O VTY recusou a alteração</p>
                  {refusal.items.length > 0 ? (
                    <DiagnosticsList items={refusal.items} />
                  ) : (
                    <p className="text-destructive text-sm">{refusal.message}</p>
                  )}
                </div>
              )}
              <Button type="submit" disabled={applying || !lines.trim()}>
                {applying && <Loader2Icon className="animate-spin" />}
                Aplicar no candidate
              </Button>
            </form>

            {applied.length > 0 && (
              <div className="mt-6 space-y-3">
                <h3 className="text-sm font-medium">Aplicado neste candidate</h3>
                <ol className="space-y-2">
                  {applied.map((a, i) => (
                    <li key={i} className="bg-muted/50 rounded-md border p-2 font-mono text-xs">
                      <div className="text-muted-foreground">{a.path.length ? a.path.join(" › ") : "(topo)"}</div>
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
            <CardDescription>Como ficará o show running-config depois do commit</CardDescription>
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
        title="Aplicar alteração"
        keepCandidateOnCancel
        onClose={() => setReviewing(false)}
        onCommitted={() => void onDone(true)}
      />
    </>
  )
}
