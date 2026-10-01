import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from "lucide-react"

import type { Diagnostic } from "@/lib/types"
import { cn } from "@/lib/utils"

const STYLE = {
  error: { icon: CircleAlertIcon, cls: "text-destructive", label: "Error" },
  warning: { icon: TriangleAlertIcon, cls: "text-amber-600 dark:text-amber-400", label: "Warning" },
  note: { icon: InfoIcon, cls: "text-muted-foreground", label: "Note" },
  unspecified: { icon: InfoIcon, cls: "text-muted-foreground", label: "Note" },
} as const

/** What the VTY said about the change, with the path and line it refers to. */
export function DiagnosticsList({ items, className }: { items: Diagnostic[]; className?: string }) {
  if (items.length === 0) return null
  return (
    <ul className={cn("space-y-2", className)}>
      {items.map((d, i) => {
        const s = STYLE[d.severity] ?? STYLE.note
        return (
          <li key={i} className="flex gap-2 text-sm">
            <s.icon className={cn("mt-0.5 size-4 shrink-0", s.cls)} aria-label={s.label} />
            <div className="min-w-0">
              <div className={d.severity === "error" ? "text-destructive" : ""}>{d.message}</div>
              {(d.path.length > 0 || d.line) && (
                <div className="text-muted-foreground font-mono text-xs">
                  {d.path.join(" › ")}
                  {d.path.length > 0 && d.line && " › "}
                  {d.line}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
