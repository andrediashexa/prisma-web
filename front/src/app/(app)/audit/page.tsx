"use client"

import { Fragment, useState } from "react"
import useSWRInfinite from "swr/infinite"
import { ChevronRightIcon, Loader2Icon } from "lucide-react"

import { ACTION_LABEL, AuditActionBadge } from "@/components/audit-action"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import type { AuditEntry, AuditPage } from "@/lib/types"
import { cn } from "@/lib/utils"

const FILTERS = [
  { value: "all", label: "Todos os eventos" },
  { value: "router.", label: "Mudanças no roteador" },
  { value: "user.", label: "Usuários" },
  { value: "auth.", label: "Acessos" },
]

export default function AuditPageView() {
  const [action, setAction] = useState("all")
  const [open, setOpen] = useState<number | null>(null)

  const { data, size, setSize, isValidating } = useSWRInfinite<AuditPage>(
    (index, prev: AuditPage | null) => {
      if (prev && prev.next_before === null) return null
      const params = new URLSearchParams({ limit: "50" })
      if (action !== "all") params.set("action", action)
      if (prev?.next_before) params.set("before", String(prev.next_before))
      return `/audit?${params}`
    },
    fetcher,
    { refreshInterval: 30_000 },
  )

  const items = data?.flatMap((p) => p.items) ?? []
  const hasMore = data?.at(-1)?.next_before != null

  return (
    <>
      <PageHeader title="Log de mudanças" description="Registro de alterações e acessos. Os eventos não podem ser editados nem apagados pela interface.">
        <Select value={action} onValueChange={(v) => { setAction(v); setOpen(null) }}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PageHeader>

      <Card className="py-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Quando</TableHead>
                <TableHead>Usuário</TableHead>
                <TableHead>Ação</TableHead>
                <TableHead>Alvo</TableHead>
                <TableHead>Origem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-48 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {data && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-10 text-center">
                    Nenhum evento encontrado.
                  </TableCell>
                </TableRow>
              )}
              {items.map((e) => (
                <Fragment key={e.id}>
                  <TableRow className="cursor-pointer" onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <TableCell>
                      <ChevronRightIcon className={cn("text-muted-foreground size-4 transition-transform", open === e.id && "rotate-90")} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(e.at)}</TableCell>
                    <TableCell className="font-medium">{e.username ?? "—"}</TableCell>
                    <TableCell>
                      <AuditActionBadge action={e.action} success={e.success} />
                    </TableCell>
                    <TableCell className="font-mono text-sm">{e.target ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">{e.ip ?? "—"}</TableCell>
                  </TableRow>
                  {open === e.id && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell />
                      <TableCell colSpan={5}>
                        <AuditDetails entry={e} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => setSize(size + 1)} disabled={isValidating}>
            {isValidating && <Loader2Icon className="animate-spin" />}
            Carregar mais
          </Button>
        </div>
      )}
    </>
  )
}

/** Mostra mudanças `{campo: {from, to}}` como diff; o resto como JSON. */
function AuditDetails({ entry }: { entry: AuditEntry }) {
  const changes = Object.entries(entry.details).filter(
    ([, v]) => v && typeof v === "object" && "from" in (v as object) && "to" in (v as object),
  ) as [string, { from: unknown; to: unknown }][]
  const rest = Object.fromEntries(Object.entries(entry.details).filter(([k]) => !changes.some(([c]) => c === k)))
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "∅" : String(v))

  return (
    <div className="space-y-3 py-1 text-sm">
      <div className="text-muted-foreground text-xs">
        #{entry.id} · {ACTION_LABEL[entry.action] ? entry.action : "evento"}
      </div>
      {changes.length > 0 && (
        <div className="grid gap-1.5">
          {changes.map(([field, { from, to }]) => (
            <div key={field} className="flex flex-wrap items-center gap-2 font-mono text-xs">
              <span className="text-muted-foreground w-28">{field}</span>
              <span className="bg-destructive/10 text-destructive rounded px-1.5 py-0.5 line-through">{show(from)}</span>
              <span className="text-muted-foreground">→</span>
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">{show(to)}</span>
            </div>
          ))}
        </div>
      )}
      {Object.keys(rest).length > 0 && (
        <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">{JSON.stringify(rest, null, 2)}</pre>
      )}
    </div>
  )
}
