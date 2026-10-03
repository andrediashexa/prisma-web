"use client"

import { useId } from "react"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

/** A labelled input of the routing forms; `error` replaces the hint once something is typed. */
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  disabled,
  type,
  list,
  className,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  error?: string | null
  disabled?: boolean
  type?: string
  list?: string
  className?: string
}) {
  const id = useId()
  const shown = value && error && error !== "required" ? error : null
  return (
    <div className={cn("grid gap-1", className)}>
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        type={type}
        list={list}
        className={cn("h-8 font-mono", shown && "border-destructive")}
      />
      {(shown || hint) && <span className={cn("text-xs", shown ? "text-destructive" : "text-muted-foreground")}>{shown ?? hint}</span>}
    </div>
  )
}

export function SwitchField({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
    </div>
  )
}

/** The first problem among labelled checks, for a disabled button's reason. */
export function firstProblem(checks: [string, string | null][]): string | null {
  const bad = checks.find(([, why]) => why)
  return bad ? `${bad[0]}: ${bad[1]}` : null
}
