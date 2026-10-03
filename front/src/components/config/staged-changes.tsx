"use client"

import { Loader2Icon, PlayIcon, Undo2Icon } from "lucide-react"

import { ChangeReview } from "@/components/config/change-review"
import { DiagnosticsList } from "@/components/config/diagnostics"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { ConfigChanges } from "@/hooks/use-config-changes"
import { cn } from "@/lib/utils"

/**
 * The changes a page staged (useConfigChanges), the VTY's refusal if any, and
 * the review that commits them. The list shows only while something is staged.
 */
export function StagedChanges({
  routerId,
  changes,
  title,
  onCommitted,
}: {
  routerId: string
  changes: ConfigChanges
  /** The review dialog's title. */
  title: string
  onCommitted?: () => void
}) {
  const { staged, refusal, preparing } = changes
  return (
    <>
      {staged.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Changes to review</CardTitle>
            <CardDescription>Applied together to one candidate; nothing reaches the router before the review.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {staged.map((e, n) => (
              <div key={n} data-staged className={cn("flex items-center gap-2 rounded-md border px-3 py-2 text-sm", refusal?.edit === e && "border-destructive")}>
                <span className="text-muted-foreground font-mono text-xs">{e.path.length ? e.path.join(" › ") : "top"}</span>
                <span className="font-mono">{e.lines.join(" ; ")}</span>
                <Button size="icon" variant="ghost" className="ml-auto size-7" aria-label="Drop this change" onClick={() => changes.drop(n)}>
                  <Undo2Icon />
                </Button>
              </div>
            ))}
            {refusal && (
              <div className="border-destructive/40 bg-destructive/5 space-y-2 rounded-lg border p-3">
                <p className="text-destructive text-sm font-medium">The VTY rejected a change</p>
                {refusal.items.length > 0 ? <DiagnosticsList items={refusal.items} /> : <p className="text-destructive text-sm">{refusal.message}</p>}
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <Button onClick={changes.review} disabled={preparing}>
                {preparing ? <Loader2Icon className="animate-spin" /> : <PlayIcon />} Review and apply ({staged.length})
              </Button>
              <Button variant="ghost" onClick={changes.clear}>
                Discard all
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      <ChangeReview
        routerId={routerId}
        candidateId={changes.reviewing}
        title={title}
        onClose={changes.closeReview}
        onCommitted={() => {
          changes.clear()
          onCommitted?.()
        }}
      />
    </>
  )
}
