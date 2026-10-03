"use client"

import Link from "next/link"
import { useState } from "react"
import { ExternalLinkIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { Callout, ChoiceField, LinesPreview, TextField } from "@/components/cgnat/fields"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { ConfigChange } from "@/hooks/use-config-changes"
import {
  ALGS,
  emptyPool,
  poolChanges,
  poolErrors,
  poolKey,
  remapReasons,
  remapWarning,
  type PoolConfig,
  type PoolScalar,
} from "@/lib/cgnat-config"

/**
 * A pool's frequent statements (#41): prefixes, block size, mode, policy,
 * limits, filtering and ALGs. The rest of the pool's statements stay in
 * Settings, linked from here.
 */
export function PoolDialog({
  routerId,
  pool,
  open,
  taken,
  onClose,
  onStage,
}: {
  routerId: string
  /** The configured pool; null for a new one. */
  pool: PoolConfig | null
  open: boolean
  /** Names already in use. */
  taken: string[]
  onClose: () => void
  onStage: (changes: ConfigChange[]) => void
}) {
  const [form, setForm] = useState<PoolConfig>(pool ?? emptyPool())
  // Reset when opened for another pool, not when a refresh hands the same pool again.
  const [shownFor, setShownFor] = useState<string | undefined>(undefined)
  const target = open ? (pool?.name ?? "") : undefined
  if (target !== shownFor) {
    setShownFor(target)
    if (open) setForm(pool ?? emptyPool())
  }
  const errors = poolErrors(pool, form, taken)
  const changes = Object.keys(errors).length ? [] : poolChanges(pool, form)
  const remap = remapReasons(pool, form)
  const scalar = (k: PoolScalar) => form.scalars[k]
  const setScalar = (k: PoolScalar, v: string) => setForm((f) => ({ ...f, scalars: { ...f.scalars, [k]: v } }))
  const [lo = "", hi = ""] = scalar("ports").split(/\s+/)
  const setPorts = (l: string, h: string) => setScalar("ports", l.trim() || h.trim() ? `${l.trim()} ${h.trim()}` : "")

  const prefixList = (side: "inside" | "outside", title: string, example: string) => (
    <div className="space-y-2">
      <Label>{title}</Label>
      {form[side].map((x, n) => (
        <div key={n} className="flex items-start gap-2">
          <div className="flex-1">
            <TextField
              label={`${title} ${n + 1}`}
              className="[&>label]:sr-only"
              value={x}
              placeholder={example}
              error={errors[`${side} ${n}`]}
              onChange={(v) => setForm((f) => ({ ...f, [side]: f[side].map((y, k) => (k === n ? v : y)) }))}
            />
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="mt-0.5 size-8"
            aria-label={`Remove ${side} prefix ${x || n + 1}`}
            onClick={() => setForm((f) => ({ ...f, [side]: f[side].filter((_, k) => k !== n) }))}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      {errors[side] && <p className="text-destructive text-xs">{errors[side]}</p>}
      <Button variant="outline" size="sm" onClick={() => setForm((f) => ({ ...f, [side]: [...f[side], ""] }))}>
        <PlusIcon /> Add {side === "inside" ? "an inside" : "an outside"} prefix
      </Button>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{pool ? `Pool ${pool.name}` : "New pool"}</DialogTitle>
          <DialogDescription>
            Subscribers from the inside prefixes are translated to the outside ones, in blocks of ports.
          </DialogDescription>
        </DialogHeader>

        {!pool && (
          <TextField label="Name" value={form.name} error={form.name ? errors.name : undefined} placeholder="BUSINESS" onChange={(name) => setForm((f) => ({ ...f, name }))} />
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {prefixList("inside", "Inside prefixes", "100.64.0.0/10")}
          {prefixList("outside", "Outside prefixes", "203.0.113.0/26")}
        </div>

        <section className="grid gap-3 sm:grid-cols-3">
          <TextField
            label="Block size (ports)"
            value={scalar("block-size")}
            numeric
            placeholder="default"
            error={errors["block-size"]}
            onChange={(v) => setScalar("block-size", v)}
          />
          <ChoiceField
            label="Mode"
            value={scalar("mode")}
            onChange={(v) => setScalar("mode", v)}
            options={[...(pool?.scalars.mode ? [] : ([["", "Default"]] as [string, string][])), ["dynamic", "Dynamic"], ["deterministic", "Deterministic"]]}
          />
          <ChoiceField
            label="Policy"
            value={scalar("policy")}
            onChange={(v) => setScalar("policy", v)}
            options={[...(pool?.scalars.policy ? [] : ([["", "Default"]] as [string, string][])), ["interleaved", "Interleaved"], ["blocked", "Blocked"]]}
          />
          <TextField label="Max blocks a subscriber" value={scalar("max-blocks")} numeric placeholder="default" error={errors["max-blocks"]} onChange={(v) => setScalar("max-blocks", v)} />
          <TextField
            label="Initial allocation (ports)"
            value={scalar("initial-allocation")}
            numeric
            placeholder="default"
            error={errors["initial-allocation"]}
            onChange={(v) => setScalar("initial-allocation", v)}
          />
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <TextField label="Ports from" value={lo} numeric placeholder="1024" onChange={(v) => setPorts(v, hi)} className="flex-1" />
              <TextField label="to" value={hi} numeric placeholder="65535" onChange={(v) => setPorts(lo, v)} className="flex-1" />
            </div>
            {errors.ports && <p className="text-destructive text-xs">{errors.ports}</p>}
          </div>
          <TextField
            label="Utilisation alarm (%)"
            value={scalar("utilisation-alarm")}
            numeric
            placeholder="off"
            error={errors["utilisation-alarm"]}
            onChange={(v) => setScalar("utilisation-alarm", v)}
          />
          <TextField label="Max sessions a subscriber" value={scalar("max-sessions")} numeric placeholder="no limit" error={errors["max-sessions"]} onChange={(v) => setScalar("max-sessions", v)} />
          <TextField
            label="Max new sessions a second"
            value={scalar("max-session-rate")}
            numeric
            placeholder="no limit"
            error={errors["max-session-rate"]}
            onChange={(v) => setScalar("max-session-rate", v)}
          />
          <ChoiceField
            label="Filtering"
            value={scalar("filter")}
            onChange={(v) => setScalar("filter", v)}
            options={[["", "Default"], ["endpoint-independent", "Endpoint independent"], ["address-dependent", "Address dependent"]]}
          />
          <div className="flex items-center gap-3 pt-6">
            <Switch id="pool-tcp-mss" checked={scalar("tcp-mss") === "auto"} onCheckedChange={(c) => setScalar("tcp-mss", c ? "auto" : "")} />
            <Label htmlFor="pool-tcp-mss">Clamp TCP MSS (auto)</Label>
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">Application gateways (ALG)</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {ALGS.map((a) => (
              <ChoiceField
                key={a}
                label={a.toUpperCase()}
                value={form.algs[a]}
                onChange={(v) => setForm((f) => ({ ...f, algs: { ...f.algs, [a]: v } }))}
                options={[["", "Default"], ["on", "On"], ["off", "Off"]]}
              />
            ))}
          </div>
        </section>

        {pool && (
          <section className="space-y-1 text-sm">
            <h3 className="font-medium">Other statements of this pool</h3>
            {pool.other.length > 0 ? (
              <ul className="text-muted-foreground font-mono text-xs">
                {pool.other.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-xs">None. Timeouts, bypasses, port forwards and VRFs are set in Settings.</p>
            )}
            <Link href={`/routers/${routerId}/settings?at=${encodeURIComponent(poolKey(pool.name))}`} className="text-primary inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline">
              Every statement of the pool in Settings <ExternalLinkIcon className="size-3" />
            </Link>
          </section>
        )}

        {remap.length > 0 && <Callout>{remapWarning(remap.join(" and "))}</Callout>}
        <LinesPreview lines={changes.flatMap((c) => c.lines)} empty={Object.keys(errors).length ? "Fix the fields above first." : "Nothing changes yet."} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={changes.length === 0}
            onClick={() => {
              onStage(changes)
              onClose()
            }}
          >
            Add to the changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
