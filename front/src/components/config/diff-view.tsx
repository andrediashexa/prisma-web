import { cn } from "@/lib/utils"

/** Diff in the `show configuration compare` format (lines with + / -). */
export function DiffView({ diff, className }: { diff: string; className?: string }) {
  const lines = diff.replace(/\n$/, "").split("\n")
  return (
    <pre className={cn("bg-muted/50 max-h-96 overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed", className)}>
      {lines.map((l, i) => {
        const t = l.trimStart()
        const kind = t.startsWith("+") ? "add" : t.startsWith("-") ? "del" : "ctx"
        return (
          <div
            key={i}
            className={cn(
              "-mx-3 px-3 whitespace-pre",
              kind === "add" && "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
              kind === "del" && "bg-destructive/10 text-destructive",
              kind === "ctx" && "text-muted-foreground",
            )}
          >
            {l || " "}
          </div>
        )
      })}
    </pre>
  )
}

/** Configuration text with line numbers. */
export function ConfigView({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\n$/, "").split("\n")
  return (
    <pre className={cn("bg-muted/50 overflow-auto rounded-lg border py-3 font-mono text-xs leading-relaxed", className)}>
      {lines.map((l, i) => (
        <div key={i} className="flex">
          <span className="text-muted-foreground/60 w-12 shrink-0 pr-3 text-right select-none">{i + 1}</span>
          <span className={cn("whitespace-pre pr-3", l.trim() === "!" && "text-muted-foreground/60")}>{l || " "}</span>
        </div>
      ))}
    </pre>
  )
}
