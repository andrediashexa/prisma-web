"use client"

import Link from "next/link"
import { useState } from "react"
import { ExternalLinkIcon, PlusIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  addressProblem,
  fieldProblems,
  interfaceChange,
  type InterfaceConfig,
} from "@/lib/interface-config"
import { invalid } from "@/lib/config-model"
import { MTU_MAX, MTU_MIN } from "@/lib/types"
import { cn } from "@/lib/utils"

/** What the dialog edits: the configuration it started from and the one to show (a re-edit starts from the staged state). */
export interface InterfaceEditing {
  running: InterfaceConfig
  start: InterfaceConfig
  /** A bundle created in this session: it has no Settings page yet. */
  isNew?: boolean
}

/**
 * The form of one port or bundle (#40): the statements set every day, the
 * addresses checked as they are added, the rest of the interface on the
 * Settings page. Saving stages the lines; nothing reaches the router before
 * the review.
 */
export function InterfaceForm({
  routerId,
  editing,
  all,
  onClose,
  onSave,
  typedBox = false,
}: {
  routerId: string
  /** The box answers SetConfig for interfaces (#46): the form sends fields, not lines. */
  typedBox?: boolean
  editing: InterfaceEditing | null
  /** Every interface, for overlaps and bundle members. */
  all: InterfaceConfig[]
  onClose: () => void
  onSave: (running: InterfaceConfig, cur: InterfaceConfig) => void
}) {
  const [cur, setCur] = useState<InterfaceConfig | null>(null)
  const [typed, setTyped] = useState({ ipv4: "", ipv6: "" })
  const [pref64, setPref64] = useState("")
  const [shownFor, setShownFor] = useState<InterfaceEditing | null>(null)
  if (editing !== shownFor) {
    setShownFor(editing)
    setCur(editing ? structuredClone(editing.start) : null)
    setTyped({ ipv4: "", ipv6: "" })
    setPref64("")
  }
  if (!editing || !cur) return <Dialog open={false} />

  const set = (p: Partial<InterfaceConfig>) => setCur({ ...cur, ...p })
  const problems = fieldProblems(cur)
  const change = interfaceChange(editing.running, cur, typedBox)
  const lines = [...change.lines, ...(change.summary ?? [])]
  const pendingTyped = typed.ipv4.trim() || typed.ipv6.trim() || pref64.trim()
  const blocked = Object.keys(problems).length > 0 || !!pendingTyped
  // Ports that can join this bundle: not a bundle, the loopback or a VLAN, nor in another bundle.
  const memberOptions = all
    .filter((i) => !i.bundle && i.name !== "lo" && !i.name.includes("."))
    .filter((i) => !all.some((b) => b.bundle && b.name !== cur.name && b.members.includes(i.name)))
    .map((i) => i.name)
  for (const m of cur.members) if (!memberOptions.includes(m)) memberOptions.push(m)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {editing.isNew ? "New bundle" : "Edit"} <span className="font-mono">{cur.name}</span>
          </DialogTitle>
          <DialogDescription>
            {cur.bundle ? "Bundle (bond)" : "Port"} · the changes go to the list to review, then to the router after the review.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[62vh] space-y-6 overflow-y-auto pr-1">
          <Section title="General">
            <div className="grid gap-4 sm:grid-cols-[1fr_10rem_auto]">
              <Field>
                <FieldLabel htmlFor="if-description">Description</FieldLabel>
                <Input id="if-description" value={cur.description} maxLength={64} onChange={(e) => set({ description: e.target.value })} />
              </Field>
              <Field data-invalid={!!problems.mtu}>
                <FieldLabel htmlFor="if-mtu">MTU</FieldLabel>
                <Input
                  id="if-mtu"
                  inputMode="numeric"
                  value={cur.mtu}
                  placeholder="default"
                  aria-invalid={!!problems.mtu}
                  onChange={(e) => set({ mtu: e.target.value.trim() })}
                />
                {problems.mtu ? <FieldError>{problems.mtu}</FieldError> : <FieldDescription>{MTU_MIN}-{MTU_MAX}</FieldDescription>}
              </Field>
              <Field>
                <FieldLabel htmlFor="if-enabled">Enabled</FieldLabel>
                <div className="flex h-9 items-center gap-2">
                  <Switch id="if-enabled" checked={!cur.shutdown} onCheckedChange={(on) => set({ shutdown: !on })} />
                  <span className={cn("text-sm", cur.shutdown && "text-destructive")}>{cur.shutdown ? "shut down" : "up"}</span>
                </div>
              </Field>
            </div>
          </Section>

          <Section title="Addresses" hint="Dual stack: IPv4 and IPv6 side by side. Each address is checked before it is added.">
            <div className="grid gap-4 sm:grid-cols-2">
              {(["ipv4", "ipv6"] as const).map((fam) => (
                <AddressEditor
                  key={fam}
                  family={fam}
                  list={cur[fam]}
                  typed={typed[fam]}
                  onType={(v) => setTyped({ ...typed, [fam]: v })}
                  problem={(v) => addressProblem(fam, v, cur, all)}
                  onAdd={(v) => {
                    set({ [fam]: [...cur[fam], v] })
                    setTyped({ ...typed, [fam]: "" })
                  }}
                  onRemove={(v) => set({ [fam]: cur[fam].filter((a) => a !== v) })}
                />
              ))}
            </div>
          </Section>

          {cur.bundle && (
            <Section title="Bundle" hint="The ports that make it up and how LACP runs on them.">
              <div className="space-y-2">
                <span className="text-sm font-medium">Members</span>
                {memberOptions.length === 0 && <p className="text-muted-foreground text-sm">No free port to add.</p>}
                <div className="flex flex-wrap gap-2">
                  {memberOptions.map((m) => {
                    const on = cur.members.includes(m)
                    return (
                      <label key={m} className={cn("flex items-center gap-2 rounded-md border px-2 py-1", on && "border-primary")}>
                        <Switch
                          checked={on}
                          aria-label={`Member ${m}`}
                          onCheckedChange={(c) => set({ members: c ? [...cur.members, m] : cur.members.filter((x) => x !== m) })}
                        />
                        <span className="font-mono text-sm">{m}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Choice label="LACP mode" value={cur.lacpMode} options={["active", "passive"]} onChange={(v) => set({ lacpMode: v as InterfaceConfig["lacpMode"] })} />
                <Choice label="LACP rate" value={cur.lacpRate} options={["fast", "slow"]} onChange={(v) => set({ lacpRate: v as InterfaceConfig["lacpRate"] })} />
                <Choice
                  label="Load balance"
                  value={cur.loadBalance}
                  options={["l2", "l23", "l34"]}
                  onChange={(v) => set({ loadBalance: v as InterfaceConfig["loadBalance"] })}
                />
              </div>
            </Section>
          )}

          <Section title="Forwarding">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field data-invalid={!!problems.vrf}>
                <FieldLabel htmlFor="if-vrf">VRF</FieldLabel>
                <Input id="if-vrf" inputMode="numeric" value={cur.vrf} placeholder="default" onChange={(e) => set({ vrf: e.target.value.trim() })} />
                {problems.vrf ? <FieldError>{problems.vrf}</FieldError> : <FieldDescription>Table id; empty is the default VRF.</FieldDescription>}
              </Field>
              <Choice
                label="CGNAT side"
                value={cur.cgnat}
                options={["inside", "outside"]}
                onChange={(v) => set({ cgnat: v as InterfaceConfig["cgnat"] })}
                hint="Inside faces the subscribers."
              />
              <Choice
                label="uRPF"
                value={cur.urpf}
                options={["strict", "loose", "off"]}
                onChange={(v) => set({ urpf: v as InterfaceConfig["urpf"] })}
                hint="Unicast reverse-path check."
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={cur.suppressRa} onCheckedChange={(c) => set({ suppressRa: c })} aria-label="Suppress router advertisements" />
              Suppress IPv6 router advertisements (<span className="font-mono">ipv6 nd suppress-ra</span>)
            </label>
            {/* PREF64 (Prisma 0.150.2, #61): a subscriber's CLAT learns the NAT64 prefix from the advertisements. */}
            {(!cur.suppressRa || cur.pref64.length > 0) && (
              <div className="max-w-md" data-pref64>
                <AddressEditor
                  family="ipv6"
                  title="NAT64 prefixes (PREF64)"
                  noun="prefix"
                  example="64:ff9b::/96"
                  list={cur.pref64}
                  typed={pref64}
                  onType={setPref64}
                  problem={(v) =>
                    invalid({ k: "ipv6_prefix" }, v) ?? (cur.pref64.includes(v) ? "already in the list" : null)
                  }
                  onAdd={(v) => {
                    set({ pref64: [...cur.pref64, v] })
                    setPref64("")
                  }}
                  onRemove={(v) => set({ pref64: cur.pref64.filter((p) => p !== v) })}
                />
                {problems.pref64 ? (
                  <p className="text-destructive mt-1 text-xs">{problems.pref64}</p>
                ) : (
                  <p className="text-muted-foreground mt-1 text-xs">Carried in the router advertisements; a NAT64 pool must translate each prefix.</p>
                )}
              </div>
            )}
          </Section>

          <Section title="Link">
            <div className="grid gap-4 sm:grid-cols-4">
              <Field data-invalid={!!problems.vlan}>
                <FieldLabel htmlFor="if-vlan">VLAN</FieldLabel>
                <Input id="if-vlan" inputMode="numeric" value={cur.vlan} placeholder="none" onChange={(e) => set({ vlan: e.target.value.trim() })} />
                {problems.vlan && <FieldError>{problems.vlan}</FieldError>}
              </Field>
              <Field data-invalid={!!problems.vlanInner}>
                <FieldLabel htmlFor="if-vlan-inner">Inner VLAN</FieldLabel>
                <Input id="if-vlan-inner" inputMode="numeric" value={cur.vlanInner} placeholder="none" onChange={(e) => set({ vlanInner: e.target.value.trim() })} />
                {problems.vlanInner && <FieldError>{problems.vlanInner}</FieldError>}
              </Field>
              <Field data-invalid={!!problems.linuxName}>
                <FieldLabel htmlFor="if-linux-name">Linux name</FieldLabel>
                <Input id="if-linux-name" value={cur.linuxName} placeholder="default" onChange={(e) => set({ linuxName: e.target.value })} />
                {problems.linuxName && <FieldError>{problems.linuxName}</FieldError>}
              </Field>
              <Field data-invalid={!!problems.macAddress}>
                <FieldLabel htmlFor="if-mac">MAC address</FieldLabel>
                <Input id="if-mac" value={cur.macAddress} placeholder="hardware" onChange={(e) => set({ macAddress: e.target.value })} />
                {problems.macAddress && <FieldError>{problems.macAddress}</FieldError>}
              </Field>
            </div>
          </Section>

          {!editing.isNew && (
            <Section title="Other settings" hint="OSPF, IS-IS, VRRP and every other statement of this interface are on the Settings page.">
              {cur.others.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {cur.others.map((l) => (
                    <Badge key={l} variant="outline" className="font-mono">
                      {l}
                    </Badge>
                  ))}
                </div>
              )}
              <Button asChild variant="outline" size="sm">
                <Link href={`/routers/${routerId}/settings?at=${encodeURIComponent(`interface ${cur.name}`)}`}>
                  <ExternalLinkIcon /> All settings of {cur.name}
                </Link>
              </Button>
            </Section>
          )}
        </div>

        <div className="rounded-md border px-3 py-2">
          <div className="text-muted-foreground mb-1 text-xs">
            {typedBox ? `Fields for interface ${cur.name}: the router writes the lines, shown in the review` : `Lines for interface ${cur.name}`}
          </div>
          {lines.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing changed yet.</p>
          ) : (
            <pre data-testid={typedBox ? "interface-fields" : "interface-lines"} className="font-mono text-xs whitespace-pre-wrap">
              {lines.join("\n")}
            </pre>
          )}
          {pendingTyped && <p className="text-destructive mt-1 text-xs">Add or clear the address you typed first.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={blocked || lines.length === 0} onClick={() => onSave(editing.running, cur)}>
            Add to the changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

const UNSET = "unset"

/** A choice among keywords, "not set" leaving the box's default. */
function Choice({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
  hint?: string
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select value={value || UNSET} onValueChange={(v) => onChange(v === UNSET ? "" : v)}>
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>Not set</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o} className="font-mono">
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  )
}

function AddressEditor({
  family,
  list,
  typed,
  onType,
  problem,
  onAdd,
  onRemove,
  title,
  noun = "address",
  example,
}: {
  family: "ipv4" | "ipv6"
  list: string[]
  typed: string
  onType: (v: string) => void
  problem: (v: string) => string | null
  onAdd: (v: string) => void
  onRemove: (v: string) => void
  /** Another list than the interface's addresses (PREF64, #61). */
  title?: string
  noun?: string
  example?: string
}) {
  const label = title ?? (family === "ipv4" ? "IPv4" : "IPv6")
  const v = typed.trim()
  const why = v ? problem(v) : null
  const add = () => v && !why && onAdd(v)
  return (
    <div className="space-y-2">
      <span className="text-sm font-medium">{label}</span>
      <div className="space-y-1">
        {list.length === 0 && <p className="text-muted-foreground text-sm">No {label} {noun}.</p>}
        {list.map((a) => (
          <div key={a} className="flex items-center gap-2 rounded-md border px-2 py-1">
            <span className="font-mono text-sm">{a}</span>
            <Button size="icon" variant="ghost" className="ml-auto size-6" aria-label={`Remove ${a}`} onClick={() => onRemove(a)}>
              <XIcon />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          aria-label={`New ${label} ${noun}`}
          aria-invalid={!!why}
          value={typed}
          placeholder={example ?? (family === "ipv4" ? "192.0.2.1/24" : "2001:db8::1/64")}
          className={cn("font-mono", why && "border-destructive")}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              add()
            }
          }}
        />
        <Button variant="outline" disabled={!v || !!why} onClick={add} aria-label={`Add ${label} ${noun}`}>
          <PlusIcon /> Add
        </Button>
      </div>
      {why && <p className="text-destructive text-xs">{why}</p>}
    </div>
  )
}
