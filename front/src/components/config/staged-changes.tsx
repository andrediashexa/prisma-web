"use client"

import { Loader2Icon, PlayIcon, Undo2Icon } from "lucide-react"

import { DiagnosticsList } from "@/components/config/diagnostics"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { useConfigChanges } from "@/hooks/use-config-changes"
import { cn } from "@/lib/utils"

/** The changes staged with useConfigChanges, the VTY's refusal if any, and the way to the review. */
export function StagedChanges({ cc }: { cc: ReturnType<typeof useConfigChanges> }) {
  if (cc.changes.length === 0 && !cc.refusal) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Changes to review</CardTitle>
        <CardDescription>Applied together to one candidate; nothing reaches the router before the review.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {cc.changes.map((e, n) => (
          <div
            key={n}
            data-staged
            className={cn("flex items-center gap-2 rounded-md border px-3 py-2 text-sm", cc.refusal?.change === e && "border-destructive")}
          >
            <span className="text-muted-foreground shrink-0 font-mono text-xs">{e.path.length ? e.path.join(" › ") : "top"}</span>
            <span className="min-w-0 font-mono break-words">{e.lines.join(" ; ")}</span>
            <Button size="icon" variant="ghost" className="ml-auto size-7 shrink-0" aria-label="Drop this change" onClick={() => cc.unstage(n)}>
              <Undo2Icon />
            </Button>
          </div>
        ))}
        {cc.refusal && (
          <div className="border-destructive/40 bg-destructive/5 space-y-2 rounded-lg border p-3">
            <p className="text-destructive text-sm font-medium">The VTY rejected a change</p>
            {cc.refusal.items.length > 0 ? (
              <DiagnosticsList items={cc.refusal.items} />
            ) : (
              <p className="text-destructive text-sm">{cc.refusal.message}</p>
            )}
          </div>
        )}
        {cc.changes.length > 0 && (
          <div className="flex gap-2 pt-2">
            <Button onClick={() => cc.review()} disabled={cc.preparing}>
              {cc.preparing ? <Loader2Icon className="animate-spin" /> : <PlayIcon />} Review and apply ({cc.changes.length})
            </Button>
            <Button variant="ghost" onClick={cc.clear}>
              Discard all
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
