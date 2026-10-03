"use client"

import { Loader2Icon, PlayIcon, TriangleAlertIcon, Undo2Icon } from "lucide-react"

import { ChangeReview, discardCandidate } from "@/components/config/change-review"
import { DiagnosticsList } from "@/components/config/diagnostics"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { ConfigChanges } from "@/hooks/use-config-changes"
import { cn } from "@/lib/utils"

/**
 * The staged changes of a screen (#39, #41): each one with its lines, a
 * refusal from the VTY next to the change it hit, and the review that
 * applies them all. Renders nothing while there is nothing staged.
 */
export function StagedChanges({
  routerId,
  changes,
  reviewTitle,
  onCommitted,
}: {
  routerId: string
  changes: ConfigChanges
  reviewTitle: string
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
            {staged.map((c, n) => (
              <div key={n} className={cn("space-y-1 rounded-md border px-3 py-2 text-sm", refusal?.change === c && "border-destructive")}>
                <div className="flex items-center gap-2" title={c.label}>
                  <span className="text-muted-foreground font-mono text-xs">{c.path.length ? c.path.join(" › ") : "top"}</span>
                  <span className="min-w-0 font-mono break-words">{c.lines.join(" ; ")}</span>
                  <Button size="icon" variant="ghost" className="ml-auto size-7 shrink-0" aria-label="Drop this change" onClick={() => changes.drop(c)}>
                    <Undo2Icon />
                  </Button>
                </div>
                {c.warning && (
                  <p className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                    {c.warning}
                  </p>
                )}
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
        title={reviewTitle}
        onClose={changes.closeReview}
        onStale={() => {
          // The base moved under it: drop that candidate and apply the same changes to a new one (#10).
          const old = changes.reviewing
          changes.closeReview()
          if (old) void discardCandidate(routerId, old)
          void changes.review()
        }}
        onCommitted={() => {
          changes.clear()
          onCommitted?.()
        }}
      />
    </>
  )
}
