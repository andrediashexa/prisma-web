"use client"

import { useId } from "react"
import { TriangleAlertIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

/** A labelled input with its problem under it (the CGNAT forms, #41). */
export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  className,
  numeric,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  error?: string
  hint?: string
  placeholder?: string
  className?: string
  numeric?: boolean
}) {
  const id = useId()
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={numeric ? "numeric" : undefined}
        aria-invalid={!!error}
        className={cn("font-mono", error && "border-destructive")}
      />
      {(error || hint) && <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>{error ?? hint}</p>}
    </div>
  )
}

/** "" is not a value Radix accepts for an item: it stands for "not set". */
const UNSET = "__unset__"

export function ChoiceField<T extends string>({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string
  value: T | ""
  onChange: (v: T | "") => void
  /** [value, text]; a "" value is "not set". */
  options: [T | "", string][]
  className?: string
}) {
  const id = useId()
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Select value={value || UNSET} onValueChange={(v) => onChange(v === UNSET ? "" : (v as T))}>
        <SelectTrigger id={id} className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, text]) => (
            <SelectItem key={v || UNSET} value={v || UNSET}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/** The lines a form will stage, or why it cannot yet. */
export function LinesPreview({ lines, empty = "Nothing changes yet.", typed = false }: { lines: string[]; empty?: string; typed?: boolean }) {
  return (
    <div className="bg-muted/40 rounded-md border px-3 py-2">
      <p className="text-muted-foreground mb-1 text-xs">
        {typed ? "Fields for the router: it writes the lines, shown in the review" : "Lines for the review"}
      </p>
      {lines.length === 0 ? (
        <p className="text-muted-foreground text-sm">{empty}</p>
      ) : (
        <pre className="overflow-x-auto font-mono text-xs leading-5" data-testid="lines-preview">
          {lines.join("\n")}
        </pre>
      )}
    </div>
  )
}

export function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div role="note" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  )
}
