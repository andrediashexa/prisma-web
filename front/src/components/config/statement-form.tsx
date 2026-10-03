"use client"

import { Fragment } from "react"

import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { describe, invalid, type FormState, type Kind, type Tok } from "@/lib/config-model"
import { cn } from "@/lib/utils"

const PLACEHOLDER: Partial<Record<Kind["k"], string>> = {
  ipv4: "192.0.2.1",
  ipv4_prefix: "192.0.2.0/24",
  ipv6: "2001:db8::1",
  ipv6_prefix: "2001:db8::/64",
  address: "192.0.2.1 or 2001:db8::1",
  prefix: "192.0.2.0/24 or 2001:db8::/64",
}

/**
 * The form for one statement, generated from its syntax (#39): a keyword is
 * shown as is, a value is an input checked by its kind, an optional part is a
 * switch and alternatives are a choice.
 */
export function StatementForm({
  tokens,
  state,
  onChange,
  pathKey = "",
}: {
  tokens: Tok[]
  state: FormState
  onChange: (s: FormState) => void
  pathKey?: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {tokens.map((t, i) => {
        const k = `${pathKey}${i}`
        if (t.t === "word") {
          return (
            <span key={k} className="bg-muted rounded px-1.5 py-0.5 font-mono text-sm">
              {t.w}
            </span>
          )
        }
        if (t.t === "param") {
          const v = state.values[t.id] ?? ""
          const why = v ? invalid(t.kind, v) : null
          return (
            <span key={k} className="inline-flex flex-col">
              <span className="inline-flex items-center gap-1">
                {t.prefix && <span className="font-mono text-sm">{t.prefix}</span>}
                <Input
                  aria-label={t.label}
                  value={v}
                  onChange={(e) => onChange({ ...state, values: { ...state.values, [t.id]: e.target.value } })}
                  placeholder={PLACEHOLDER[t.kind.k] ?? (t.kind.k === "int" ? `${t.kind.min}-${t.kind.max}` : t.label)}
                  inputMode={t.kind.k === "int" ? "numeric" : undefined}
                  className={cn("h-8 font-mono", t.rest ? "w-72" : "w-44", why && "border-destructive")}
                />
              </span>
              <span className={cn("text-xs", why ? "text-destructive" : "text-muted-foreground")}>{why ?? t.label}</span>
            </span>
          )
        }
        if (t.t === "opt") {
          const on = !!state.opts[k]
          return (
            <span key={k} className="inline-flex items-center gap-2 rounded-md border border-dashed px-2 py-1">
              <Switch
                checked={on}
                onCheckedChange={(c) => onChange({ ...state, opts: { ...state.opts, [k]: c } })}
                aria-label={`Use ${describe(t.items)}`}
              />
              {on ? (
                <StatementForm tokens={t.items} state={state} onChange={onChange} pathKey={`${k}.`} />
              ) : (
                <span className="text-muted-foreground font-mono text-sm">{describe(t.items)}</span>
              )}
            </span>
          )
        }
        const choice = state.alts[k] ?? 0
        return (
          <Fragment key={k}>
            <Select value={String(choice)} onValueChange={(c) => onChange({ ...state, alts: { ...state.alts, [k]: Number(c) } })}>
              <SelectTrigger className="h-8 w-auto max-w-80 font-mono" aria-label="Choice">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {t.options.map((o, n) => (
                  <SelectItem key={n} value={String(n)} className="font-mono">
                    {describe(o)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* A choice of plain words is complete with the selector itself. */}
            {t.options[choice].some((o) => o.t !== "word") && (
              <StatementForm tokens={t.options[choice]} state={state} onChange={onChange} pathKey={`${k}.${choice}.`} />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
