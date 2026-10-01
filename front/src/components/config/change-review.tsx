"use client"

import { useEffect, useState } from "react"
import { useSWRConfig } from "swr"
import { toast } from "sonner"
import { CheckCircle2Icon, Loader2Icon, ShieldAlertIcon, XCircleIcon } from "lucide-react"

import { DiagnosticsList } from "@/components/config/diagnostics"
import { DiffView } from "@/components/config/diff-view"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { api, ApiError, errorMessage } from "@/lib/api"
import {
  routerApi,
  type CheckResponse,
  type CommitResponse,
  type CompareResponse,
  type EditResponse,
  type OpenCandidateResponse,
} from "@/lib/types"
import type { EditBlock } from "@/lib/vty"

const GATES = [
  { key: "remap", ack: "acknowledge_remap", text: "Entendo que assinantes vão mudar de endereço público ou bloco de portas." },
  { key: "cutoff", ack: "acknowledge_cutoff", text: "Entendo que o prefixo que carrega esta sessão deixará de ser anunciado." },
  { key: "diverge", ack: "acknowledge_diverge", text: "Entendo que estes pools ficarão mapeados diferente do par de HA." },
] as const

type Gate = (typeof GATES)[number]["key"]

/** Abre um candidate e aplica as edições. Fecha o candidate se o VTY recusar uma linha. */
export async function prepareCandidate(routerId: string, edits: EditBlock[]) {
  const c = await api.post<OpenCandidateResponse>(routerApi(routerId, "/config/candidates"))
  try {
    for (const e of edits) {
      if (e.lines.length === 0) continue
      await api.post<EditResponse>(routerApi(routerId, `/config/candidates/${c.candidate_id}/edit`), e)
    }
    return c.candidate_id
  } catch (err) {
    await discardCandidate(routerId, c.candidate_id)
    throw err
  }
}

export async function discardCandidate(routerId: string, cid: string) {
  await api.delete(routerApi(routerId, `/config/candidates/${cid}`)).catch(() => {})
}

/**
 * Revisão de uma alteração antes do commit: diff, `commit check`, confirmações
 * exigidas pelo VTY e opções de commit. Fechar sem aplicar descarta o candidate.
 */
export function ChangeReview({
  routerId,
  candidateId,
  title,
  defaultComment = "",
  onClose,
  onCommitted,
  keepCandidateOnCancel = false,
}: {
  routerId: string
  candidateId: string | null
  title: string
  defaultComment?: string
  onClose: () => void
  onCommitted?: (r: CommitResponse) => void
  /** O editor de configuração mantém o candidate aberto ao voltar. */
  keepCandidateOnCancel?: boolean
}) {
  const { mutate } = useSWRConfig()
  const [compare, setCompare] = useState<CompareResponse | null>(null)
  const [check, setCheck] = useState<CheckResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [acks, setAcks] = useState<Record<Gate, boolean>>({ remap: false, cutoff: false, diverge: false })
  const [comment, setComment] = useState(defaultComment)
  const [confirmed, setConfirmed] = useState(true)
  const [minutes, setMinutes] = useState("5")
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<ApiError | Error | null>(null)

  useEffect(() => {
    if (!candidateId) return
    let cancelled = false
    const base = routerApi(routerId, `/config/candidates/${candidateId}`)
    Promise.all([api.get<CompareResponse>(`${base}/compare`), api.post<CheckResponse>(`${base}/check`)])
      .then(([cmp, chk]) => {
        if (cancelled) return
        setCompare(cmp)
        setCheck(chk)
      })
      .catch((err) => !cancelled && setLoadError(errorMessage(err)))
    return () => {
      cancelled = true
    }
  }, [routerId, candidateId])

  async function cancel() {
    if (candidateId && !keepCandidateOnCancel) await discardCandidate(routerId, candidateId)
    onClose()
  }

  async function commit() {
    if (!candidateId) return
    setCommitting(true)
    setCommitError(null)
    try {
      const body: Record<string, unknown> = {
        comment,
        confirmed_minutes: confirmed ? Number(minutes) : 0,
      }
      for (const g of GATES) body[g.ack] = acks[g.key]
      const r = await api.post<CommitResponse>(routerApi(routerId, `/config/candidates/${candidateId}/commit`), body)
      toast.success(
        confirmed
          ? `Aplicado (${r.revision}). Confirme em até ${minutes} min, ou o Prisma desfaz sozinho.`
          : `Aplicado (${r.revision}).`,
      )
      // Tudo que lê deste roteador pode ter mudado.
      await mutate((key) => typeof key === "string" && key.startsWith(routerApi(routerId, "")))
      onCommitted?.(r)
      onClose()
    } catch (err) {
      setCommitError(err as Error)
    } finally {
      setCommitting(false)
    }
  }

  const gates = check ? GATES.filter((g) => check[g.key].length > 0) : []
  const gatesOk = gates.every((g) => acks[g.key])
  const canCommit = !!check?.passed && !!compare?.changed && gatesOk && !committing

  return (
    <Dialog open={!!candidateId} onOpenChange={(o) => !o && !committing && cancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Revise o que muda no roteador antes de aplicar.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto">
          {loadError && <p className="text-destructive text-sm">{loadError}</p>}
          {!loadError && (!compare || !check) && <Skeleton className="h-40 w-full" />}

          {compare && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">O que muda</h3>
              {compare.changed ? (
                <DiffView diff={compare.diff} />
              ) : (
                <p className="text-muted-foreground text-sm">Nada muda em relação à configuração em uso.</p>
              )}
            </section>
          )}

          {check && (
            <section className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                Verificação (commit check)
                {check.passed ? (
                  <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2Icon className="size-4" /> aprovada
                  </span>
                ) : (
                  <span className="text-destructive flex items-center gap-1">
                    <XCircleIcon className="size-4" /> recusada
                  </span>
                )}
              </h3>
              <DiagnosticsList items={check.diagnostics} />
              {check.diagnostics.length === 0 && check.output && (
                <p className="text-muted-foreground font-mono text-xs">{check.output}</p>
              )}
            </section>
          )}

          {gates.length > 0 && (
            <section className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
              <h3 className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
                <ShieldAlertIcon className="size-4" /> Esta alteração exige confirmação
              </h3>
              {gates.map((g) => (
                <label key={g.key} className="flex items-start gap-3 text-sm">
                  <Switch
                    checked={acks[g.key]}
                    onCheckedChange={(v) => setAcks((a) => ({ ...a, [g.key]: v }))}
                    className="mt-0.5"
                  />
                  <span>
                    {g.text}
                    <span className="text-muted-foreground mt-1 block font-mono text-xs">{check![g.key].join(", ")}</span>
                  </span>
                </label>
              ))}
            </section>
          )}

          {check?.passed && compare?.changed && (
            <section className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="commit-comment">Comentário</FieldLabel>
                <Input id="commit-comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={200} placeholder="O que e por quê" />
              </Field>
              <Field>
                <FieldLabel>Commit confirmed</FieldLabel>
                <div className="flex items-center gap-3">
                  <Switch checked={confirmed} onCheckedChange={setConfirmed} aria-label="Commit confirmed" />
                  <Select value={minutes} onValueChange={setMinutes} disabled={!confirmed}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["1", "2", "5", "10", "15", "30"].map((m) => (
                        <SelectItem key={m} value={m}>
                          {m} min
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <FieldDescription>
                  {confirmed ? "Se você perder o acesso, o Prisma desfaz a mudança sozinho." : "A mudança fica valendo imediatamente."}
                </FieldDescription>
              </Field>
            </section>
          )}

          {commitError && (
            <div className="border-destructive/40 bg-destructive/5 space-y-2 rounded-lg border p-3">
              <p className="text-destructive text-sm font-medium">{commitError.message}</p>
              {commitError instanceof ApiError && commitError.diagnostics?.items && (
                <DiagnosticsList items={commitError.diagnostics.items} />
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={cancel} disabled={committing}>
            {keepCandidateOnCancel ? "Voltar" : "Descartar"}
          </Button>
          <Button onClick={commit} disabled={!canCommit}>
            {committing && <Loader2Icon className="animate-spin" />}
            {confirmed && check?.passed ? `Aplicar (confirmar em ${minutes} min)` : "Aplicar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
