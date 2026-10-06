"use client"

import { useState } from "react"
import { Loader2Icon } from "lucide-react"

import { ChoiceField, TextField } from "@/components/cgnat/fields"
import { DiagnosticsList } from "@/components/config/diagnostics"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, ApiError } from "@/lib/api"
import {
  RENAME_KINDS,
  renameError,
  renameLine,
  replaceError,
  replaceLine,
  type RenameForm,
  type RenameKind,
  type ReplaceForm,
} from "@/lib/edit-words"
import type { Diagnostic, EditResponse } from "@/lib/types"

/**
 * `replace pattern` and `rename` (Prisma 0.151.13, #74): a pattern replaced statement by
 * statement at the editor's level, previewed with `| compare` (nothing staged) before it is
 * applied; a pool, a list, a route-map, a peer-group or an interface renamed with every
 * reference the box can follow. The box refuses, whole, what it cannot do.
 */
export function EditWords({
  base,
  path,
  onApplied,
}: {
  /** The candidate's API path. */
  base: string
  /** The editor's level. */
  path: string[]
  onApplied: (edit: { path: string[]; lines: string[]; diagnostics: Diagnostic[] }) => void
}) {
  const [replace, setReplace] = useState<ReplaceForm>({ pattern: "", replacement: "", upto: "" })
  const [rename, setRename] = useState<RenameForm>({ kind: "cgnat-pool", name: "", to: "", asn: "" })
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<{ message: string; items: Diagnostic[] } | null>(null)

  async function send(line: string, at: string[], compare: boolean) {
    setBusy(true)
    setRefusal(null)
    setPreview(null)
    try {
      const r = await api.post<EditResponse>(`${base}/edit`, { path: at, lines: [line] })
      if (compare) setPreview(r.output || "Nothing would change.")
      else onApplied({ path: at, lines: [line], diagnostics: r.diagnostics })
    } catch (err) {
      setRefusal({ message: err instanceof Error ? err.message : "Rejected", items: err instanceof ApiError ? (err.diagnostics?.items ?? []) : [] })
    } finally {
      setBusy(false)
    }
  }

  const replaceWhy = replaceError(replace)
  const renameWhy = renameError(rename)
  const at = path.length ? path.join(" › ") : "the whole configuration"

  return (
    <section className="mt-6 space-y-3" data-edit-words>
      <h3 className="text-sm font-medium">Replace or rename</h3>
      <Tabs defaultValue="replace" onValueChange={() => (setPreview(null), setRefusal(null))}>
        <TabsList>
          <TabsTrigger value="replace">Replace</TabsTrigger>
          <TabsTrigger value="rename">Rename</TabsTrigger>
        </TabsList>
        <TabsContent value="replace" className="space-y-3">
          <p className="text-muted-foreground text-xs">
            A regular expression, matched in each statement of {at} on its own; the level&apos;s own header is not touched. \1 in the
            replacement is the first group.
          </p>
          <TextField label="Pattern" value={replace.pattern} placeholder="block-size 512" onChange={(pattern) => setReplace((f) => ({ ...f, pattern }))} />
          <TextField label="Replacement" value={replace.replacement} placeholder="block-size 1024" onChange={(replacement) => setReplace((f) => ({ ...f, replacement }))} />
          <TextField
            label="At most (substitutions)"
            value={replace.upto}
            numeric
            placeholder="every match"
            error={replace.upto && replaceWhy?.startsWith("upto") ? replaceWhy : undefined}
            onChange={(upto) => setReplace((f) => ({ ...f, upto }))}
          />
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={busy || !!replaceWhy} onClick={() => send(replaceLine(replace, true), path, true)}>
              {busy && <Loader2Icon className="animate-spin" />} Preview
            </Button>
            <Button type="button" disabled={busy || !!replaceWhy} onClick={() => send(replaceLine(replace, false), path, false)}>
              Replace in the candidate
            </Button>
          </div>
        </TabsContent>
        <TabsContent value="rename" className="space-y-3">
          <p className="text-muted-foreground text-xs">The box renames it and every reference to it it can follow, or refuses the whole rename.</p>
          <ChoiceField<RenameKind>
            label="What"
            value={rename.kind}
            onChange={(v) => v && setRename((f) => ({ ...f, kind: v }))}
            options={RENAME_KINDS.map((k) => [k.value, k.label] as [RenameKind, string])}
          />
          {rename.kind === "peer-group" && <TextField label="BGP AS" value={rename.asn} numeric placeholder="65000" onChange={(asn) => setRename((f) => ({ ...f, asn }))} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Current name" value={rename.name} onChange={(name) => setRename((f) => ({ ...f, name }))} />
            <TextField label="New name" value={rename.to} onChange={(to) => setRename((f) => ({ ...f, to }))} />
          </div>
          <Button type="button" disabled={busy || !!renameWhy} onClick={() => send(renameLine(rename), [], false)}>
            Rename in the candidate
          </Button>
        </TabsContent>
      </Tabs>
      {preview !== null && (
        <pre className="bg-muted/50 max-h-64 overflow-auto rounded-md border p-2 font-mono text-xs" data-edit-preview>
          {preview}
        </pre>
      )}
      {refusal && (
        <div className="border-destructive/40 bg-destructive/5 space-y-2 rounded-lg border p-3" role="alert">
          <p className="text-destructive text-sm font-medium">The box refused it; the candidate is unchanged</p>
          {refusal.items.length > 0 ? <DiagnosticsList items={refusal.items} /> : <p className="text-destructive text-sm">{refusal.message}</p>}
        </div>
      )}
    </section>
  )
}
