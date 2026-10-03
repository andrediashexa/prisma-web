"use client"

import { useState } from "react"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { ChoiceField, LinesPreview, TextField } from "@/components/cgnat/fields"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ConfigChange } from "@/hooks/use-config-changes"
import { GLOBAL_TIMEOUTS, globalChanges, globalErrors, type CgnatGlobal, type IdentityKind, type Side } from "@/lib/cgnat-config"

const TIMEOUT_LABEL: Record<(typeof GLOBAL_TIMEOUTS)[number], string> = {
  udp: "UDP",
  icmp: "ICMP",
  "tcp-transitory": "TCP transitory",
  "tcp-established": "TCP established",
}

/**
 * `nat > cgnat` itself (#41): timeouts, block hold-down, the inside and
 * outside interfaces, how subscribers are identified, and the session table.
 */
export function GlobalDialog({
  current,
  open,
  interfaces,
  onClose,
  onStage,
}: {
  current: CgnatGlobal
  open: boolean
  /** The router's interfaces, to pick from. */
  interfaces: string[]
  onClose: () => void
  onStage: (changes: ConfigChange[]) => void
}) {
  const [form, setForm] = useState(current)
  const [shownFor, setShownFor] = useState<boolean>(false)
  if (open !== shownFor) {
    setShownFor(open)
    if (open) setForm(current)
  }
  const errors = globalErrors(current, form)
  const changes = Object.keys(errors).length ? [] : globalChanges(current, form)
  const set = (patch: Partial<CgnatGlobal>) => setForm((f) => ({ ...f, ...patch }))
  const free = interfaces.filter((n) => !form.interfaces.some((i) => i.name === n))
  const id = form.identity
  const setId = (patch: Partial<CgnatGlobal["identity"]>) => set({ identity: { ...id, ...patch } })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>CGNAT settings</DialogTitle>
          <DialogDescription>
            Settings of nat › cgnat for every pool. A value the VTY cannot unset can be changed, not cleared.
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">Timeouts (seconds)</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {GLOBAL_TIMEOUTS.map((t) => (
              <TextField
                key={t}
                label={TIMEOUT_LABEL[t]}
                value={form.timeouts[t]}
                numeric
                placeholder="default"
                error={errors[`timeout ${t}`]}
                onChange={(v) => set({ timeouts: { ...form.timeouts, [t]: v } })}
              />
            ))}
            <TextField
              label="Block hold-down"
              value={form.blockHolddown}
              numeric
              placeholder="default"
              error={errors["block-holddown"]}
              onChange={(v) => set({ blockHolddown: v })}
            />
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">Interfaces</h3>
          {form.interfaces.length === 0 && <p className="text-muted-foreground text-sm">No interface is inside or outside yet.</p>}
          {form.interfaces.map((i, n) => (
            <div key={n} className="flex flex-wrap items-center gap-2">
              <Select
                value={i.name || undefined}
                onValueChange={(name) => set({ interfaces: form.interfaces.map((x, k) => (k === n ? { ...x, name } : x)) })}
              >
                <SelectTrigger className="w-48 font-mono" aria-label={`Interface ${n + 1}`}>
                  <SelectValue placeholder="Interface" />
                </SelectTrigger>
                <SelectContent>
                  {[i.name, ...free].filter(Boolean).map((name) => (
                    <SelectItem key={name} value={name} className="font-mono">
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={i.side}
                onValueChange={(side) => set({ interfaces: form.interfaces.map((x, k) => (k === n ? { ...x, side: side as Side } : x)) })}
              >
                <SelectTrigger className="w-32" aria-label={`Side of interface ${n + 1}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inside">inside</SelectItem>
                  <SelectItem value="outside">outside</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label={`Remove interface ${i.name || n + 1}`}
                onClick={() => set({ interfaces: form.interfaces.filter((_, k) => k !== n) })}
              >
                <Trash2Icon />
              </Button>
              {errors[`interface ${n}`] && <span className="text-destructive text-xs">{errors[`interface ${n}`]}</span>}
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={free.length === 0}
            onClick={() => set({ interfaces: [...form.interfaces, { name: free[0] ?? "", side: "inside" }] })}
          >
            <PlusIcon /> Add an interface
          </Button>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">Subscriber identity</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <ChoiceField<IdentityKind>
              label="Identified by"
              value={id.kind}
              onChange={(kind) => setId({ kind })}
              options={[
                ...(current.identity.kind ? [] : ([["", "Not set"]] as [IdentityKind, string][])),
                ["none", "Nothing (none)"],
                ["file", "A file"],
                ["dhcp-leases", "DHCP leases"],
                ["radius", "RADIUS"],
              ]}
            />
            {(id.kind === "file" || id.kind === "dhcp-leases") && (
              <TextField label="Path" value={id.path} error={errors["identity path"]} onChange={(path) => setId({ path })} className="sm:col-span-2" />
            )}
            {id.kind === "radius" && (
              <>
                <TextField label="Secret" value={id.secret} error={errors["identity secret"]} onChange={(secret) => setId({ secret })} />
                <TextField label="Port" value={id.port} numeric placeholder="default" error={errors["identity port"]} onChange={(port) => setId({ port })} />
              </>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-medium">Memory</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              label="Session table buckets"
              value={form.sessionTable.buckets}
              numeric
              placeholder="default"
              error={errors["session-table buckets"]}
              onChange={(buckets) => set({ sessionTable: { ...form.sessionTable, buckets } })}
            />
            <TextField
              label="Session table memory (MB)"
              value={form.sessionTable.memory}
              numeric
              placeholder="default"
              error={errors["session-table memory"]}
              onChange={(memory) => set({ sessionTable: { ...form.sessionTable, memory } })}
            />
            <TextField label="CGNAT memory (GB)" value={form.memory} numeric placeholder="default" error={errors.memory} onChange={(memory) => set({ memory })} />
          </div>
        </section>

        <LinesPreview lines={changes.flatMap((c) => c.lines)} />
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
