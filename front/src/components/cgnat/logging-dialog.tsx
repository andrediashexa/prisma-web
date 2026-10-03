"use client"

import { useState } from "react"

import { Callout, ChoiceField, LinesPreview, TextField } from "@/components/cgnat/fields"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { ConfigChange } from "@/hooks/use-config-changes"
import {
  disablesNeverEnabledSyslog,
  LOG_KINDS,
  loggingChanges,
  loggingErrors,
  SYSLOG_DISABLE_WARNING,
  type CgnatLogging,
  type LogKind,
  type LogTarget,
} from "@/lib/cgnat-config"

export const LOG_KIND_LABEL: Record<LogKind, string> = {
  syslog: "Syslog (TCP)",
  tcp: "IPFIX over TCP",
  udp: "IPFIX over UDP",
}

/**
 * The CGNAT log collectors (#41): syslog and IPFIX over TCP or UDP, each sent
 * to a collector or disabled, and the export as a whole.
 */
export function LoggingDialog({
  current,
  open,
  onClose,
  onStage,
}: {
  current: CgnatLogging
  open: boolean
  onClose: () => void
  onStage: (changes: ConfigChange[]) => void
}) {
  const [form, setForm] = useState(current)
  const [shownFor, setShownFor] = useState(false)
  if (open !== shownFor) {
    setShownFor(open)
    if (open) setForm(current)
  }
  const errors = loggingErrors(form)
  const changes = Object.keys(errors).length ? [] : loggingChanges(current, form)
  const setTarget = (k: LogKind, patch: Partial<LogTarget>) =>
    setForm((f) => ({ ...f, targets: { ...f.targets, [k]: { ...f.targets[k], ...patch } } }))

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Log collectors</DialogTitle>
          <DialogDescription>Where the CGNAT sends its translation records. The VTY has no way to unset a collector; disable it instead.</DialogDescription>
        </DialogHeader>

        {LOG_KINDS.map((k) => {
          const t = form.targets[k]
          const was = current.targets[k].state
          return (
            <section key={k} className="space-y-3 rounded-lg border p-3" aria-label={LOG_KIND_LABEL[k]}>
              <div className="grid gap-3 sm:grid-cols-3">
                <ChoiceField<LogTarget["state"] & string>
                  label={LOG_KIND_LABEL[k]}
                  value={t.state}
                  onChange={(state) => setTarget(k, { state })}
                  options={[
                    ...(was === "" ? ([["", "Not set"]] as [LogTarget["state"], string][]) : []),
                    ["collector", "Send to a collector"],
                    ["disabled", "Disabled"],
                  ]}
                />
                {t.state === "collector" && (
                  <>
                    <TextField label="Collector" value={t.collector} placeholder="192.0.2.50" error={errors[`${k} collector`]} onChange={(collector) => setTarget(k, { collector })} />
                    {k === "syslog" ? (
                      <TextField
                        label="Enterprise number"
                        value={t.enterprise}
                        numeric
                        placeholder="32473"
                        error={errors[`${k} enterprise`]}
                        onChange={(enterprise) => setTarget(k, { enterprise })}
                      />
                    ) : (
                      <TextField label="Port" value={t.port} numeric placeholder="4739" error={errors[`${k} port`]} onChange={(port) => setTarget(k, { port })} />
                    )}
                    {k === "udp" && (
                      <TextField label="Source address" value={t.source} placeholder="203.0.113.10" error={errors[`${k} source`]} onChange={(source) => setTarget(k, { source })} />
                    )}
                    {k === "syslog" && (
                      <TextField label="Options" value={t.options} hint="The rest of the line, as the VTY takes it" onChange={(options) => setTarget(k, { options })} className="sm:col-span-2" />
                    )}
                  </>
                )}
              </div>
            </section>
          )
        })}

        <ChoiceField<"enable" | "disable">
          label="Log export"
          value={form.export}
          onChange={(v) => setForm((f) => ({ ...f, export: v }))}
          options={[...(current.export ? [] : ([["", "Not set"]] as ["" | "enable" | "disable", string][])), ["enable", "Enabled"], ["disable", "Disabled (no stream sends)"]]}
          className="sm:w-1/3"
        />

        {disablesNeverEnabledSyslog(current, form) && <Callout>{SYSLOG_DISABLE_WARNING}</Callout>}
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
