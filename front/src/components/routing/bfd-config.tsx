"use client"

import { useState } from "react"
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { SwitchField, TextField } from "@/components/routing/fields"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ConfigChange } from "@/hooks/use-config-changes"
import { invalid } from "@/lib/config-model"
import { describeSet, typedSet, useTypedConfig, type TypedBfdPeer, type TypedBfdProfile, type TypedBfdTimers } from "@/lib/typed-config"

// BFD's configuration as fields (Prisma 0.150.12, #67): sessions and profiles, staged
// and reviewed like every change. A box before 0.150.12 edits BFD in Settings.

const NUMBERS = [
  ["detect_multiplier", "Detect multiplier", 2, 255],
  ["receive_interval_ms", "Receive interval (ms)", 10, 60000],
  ["transmit_interval_ms", "Transmit interval (ms)", 10, 60000],
  ["minimum_ttl", "Minimum TTL (multi-hop)", 1, 254],
] as const
const FLAGS = [
  ["passive_mode", "Passive (wait for the peer)"],
  ["echo_mode", "Echo mode"],
  ["shutdown", "Shut down"],
] as const

type TimerForm = Record<(typeof NUMBERS)[number][0], string> & Record<(typeof FLAGS)[number][0], boolean>

const timerForm = (t: TypedBfdTimers | null | undefined): TimerForm => ({
  detect_multiplier: t?.detect_multiplier ? String(t.detect_multiplier) : "",
  receive_interval_ms: t?.receive_interval_ms ? String(t.receive_interval_ms) : "",
  transmit_interval_ms: t?.transmit_interval_ms ? String(t.transmit_interval_ms) : "",
  minimum_ttl: t?.minimum_ttl ? String(t.minimum_ttl) : "",
  passive_mode: !!t?.passive_mode,
  echo_mode: !!t?.echo_mode,
  shutdown: !!t?.shutdown,
})

/** The timers that changed, as `timers.<field>`, and the object to send. */
function timerDiff(before: TimerForm, after: TimerForm): { fields: string[]; timers: Partial<TypedBfdTimers> } {
  const fields: string[] = []
  const timers: Partial<TypedBfdTimers> = {}
  for (const [k] of NUMBERS) {
    timers[k] = Number(after[k].trim() || 0)
    if (after[k].trim() !== before[k]) fields.push(`timers.${k}`)
  }
  for (const [k] of FLAGS) {
    timers[k] = after[k]
    if (after[k] !== before[k]) fields.push(`timers.${k}`)
  }
  return { fields, timers }
}

function timerProblems(t: TimerForm): Record<string, string | null> {
  return Object.fromEntries(NUMBERS.map(([k, , min, max]) => [k, t[k].trim() ? invalid({ k: "int", min, max }, t[k].trim()) : null]))
}

function Timers({ t, set, why }: { t: TimerForm; set: (patch: Partial<TimerForm>) => void; why: Record<string, string | null> }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {NUMBERS.map(([k, label]) => (
          <TextField key={k} label={label} value={t[k]} onChange={(v) => set({ [k]: v } as Partial<TimerForm>)} placeholder="default" error={why[k]} />
        ))}
      </div>
      <div className="flex flex-wrap gap-6">
        {FLAGS.map(([k, label]) => (
          <SwitchField key={k} label={label} checked={t[k]} onChange={(v) => set({ [k]: v } as Partial<TimerForm>)} />
        ))}
      </div>
    </div>
  )
}

const timerSummary = (t: TypedBfdTimers | null) =>
  t && (t.receive_interval_ms || t.transmit_interval_ms || t.detect_multiplier)
    ? `${t.receive_interval_ms || "—"}/${t.transmit_interval_ms || "—"} ms × ${t.detect_multiplier || "—"}`
    : "defaults"

const peerKey = (p: Pick<TypedBfdPeer, "address" | "multihop" | "local_address" | "interface" | "vrf">) =>
  [p.address, p.multihop ? "multihop" : "", p.local_address, p.interface, p.vrf].join("|")

type PeerForm = { address: string; multihop: boolean; local_address: string; interface: string; vrf: string; profile: string; timers: TimerForm }

export function BfdConfig({ routerId, editable, onStage }: { routerId: string; editable: boolean; onStage: (c: ConfigChange) => void }) {
  const { config } = useTypedConfig(routerId, ["bfd"])
  const [peer, setPeer] = useState<{ before?: TypedBfdPeer } | null>(null)
  const [profile, setProfile] = useState<{ before?: TypedBfdProfile } | null>(null)
  if (!config) return null
  const peers = config.bfd_peers ?? []
  const profiles = config.bfd_profiles ?? []

  function removePeer(p: TypedBfdPeer) {
    const bfd_peer = { address: p.address, multihop: p.multihop, local_address: p.local_address, interface: p.interface, vrf: p.vrf }
    onStage({ path: ["bfd"], lines: [], typed: [{ remove: { area: "bfd", bfd_peer } }], summary: [`remove ${p.header}`], label: `remove BFD ${p.header}`, key: `bfd ${peerKey(p)}` })
  }
  function removeProfile(p: TypedBfdProfile) {
    onStage({ path: ["bfd"], lines: [], typed: [{ remove: { area: "bfd", name: p.name } }], summary: [`remove profile ${p.name}`], label: `remove BFD profile ${p.name}`, key: `bfd profile ${p.name}` })
  }

  return (
    <Card data-bfd-config>
      <CardHeader>
        <CardTitle>BFD configuration</CardTitle>
        <CardDescription>Sessions and timer profiles; a BGP neighbor or a static route names a profile to use one.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Sessions</h3>
            {editable && (
              <Button variant="outline" size="sm" onClick={() => setPeer({})}>
                <PlusIcon /> Add a session
              </Button>
            )}
          </div>
          {peers.length === 0 ? (
            <p className="text-muted-foreground text-sm">No BFD session is configured.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Peer</TableHead>
                  <TableHead>Profile</TableHead>
                  <TableHead>Timers</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {peers.map((p) => (
                  <TableRow key={peerKey(p)} data-bfd-peer={p.address}>
                    <TableCell className="font-mono text-sm">
                      {p.address}
                      {p.interface && <span className="text-muted-foreground"> · {p.interface}</span>}
                      {p.multihop && <Badge variant="outline" className="ml-2">multi-hop</Badge>}
                    </TableCell>
                    <TableCell>{p.profile || "—"}</TableCell>
                    <TableCell className="tabular-nums">{timerSummary(p.timers)}</TableCell>
                    <TableCell className="text-right">
                      {editable && (
                        <span className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" className="size-7" aria-label={`Edit BFD ${p.address}`} onClick={() => setPeer({ before: p })}>
                            <PencilIcon />
                          </Button>
                          <Button size="icon" variant="ghost" className="size-7" aria-label={`Remove BFD ${p.address}`} onClick={() => removePeer(p)}>
                            <Trash2Icon />
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Profiles</h3>
            {editable && (
              <Button variant="outline" size="sm" onClick={() => setProfile({})}>
                <PlusIcon /> Add a profile
              </Button>
            )}
          </div>
          {profiles.length === 0 ? (
            <p className="text-muted-foreground text-sm">No BFD profile.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {profiles.map((p) => (
                <li key={p.name} className="flex items-center gap-2" data-bfd-profile={p.name}>
                  <span className="font-mono">{p.name}</span>
                  <span className="text-muted-foreground tabular-nums">{timerSummary(p.timers)}</span>
                  {editable && (
                    <>
                      <Button size="icon" variant="ghost" className="size-7" aria-label={`Edit BFD profile ${p.name}`} onClick={() => setProfile({ before: p })}>
                        <PencilIcon />
                      </Button>
                      <Button size="icon" variant="ghost" className="size-7" aria-label={`Remove BFD profile ${p.name}`} onClick={() => removeProfile(p)}>
                        <Trash2Icon />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
      <PeerDialog editing={peer} profiles={profiles.map((p) => p.name)} onClose={() => setPeer(null)} onStage={onStage} />
      <ProfileDialog editing={profile} taken={profiles.map((p) => p.name)} onClose={() => setProfile(null)} onStage={onStage} />
    </Card>
  )
}

function PeerDialog({
  editing,
  profiles,
  onClose,
  onStage,
}: {
  editing: { before?: TypedBfdPeer } | null
  profiles: string[]
  onClose: () => void
  onStage: (c: ConfigChange) => void
}) {
  const start = (b?: TypedBfdPeer): PeerForm => ({
    address: b?.address ?? "",
    multihop: !!b?.multihop,
    local_address: b?.local_address ?? "",
    interface: b?.interface ?? "",
    vrf: b?.vrf ?? "",
    profile: b?.profile ?? "",
    timers: timerForm(b?.timers),
  })
  const [s, setS] = useState<PeerForm>(start())
  const [shownFor, setShownFor] = useState<typeof editing>(null)
  if (editing !== shownFor) {
    setShownFor(editing)
    setS(start(editing?.before))
  }
  const isNew = !editing?.before
  const before = start(editing?.before)
  const why = {
    ...timerProblems(s.timers),
    address: invalid({ k: "address" }, s.address.trim()),
    local_address: s.local_address.trim() ? invalid({ k: "address" }, s.local_address.trim()) : null,
    profile: s.profile.trim() && !profiles.includes(s.profile.trim()) ? `no profile ${s.profile.trim()}` : null,
  }
  const blocked = Object.values(why).some(Boolean)
  const { fields, timers } = timerDiff(before.timers, s.timers)
  if (s.profile.trim() !== before.profile) fields.push("profile")
  // A new session on its defaults still names a field: the box enters the mode.
  const sent = isNew && fields.length === 0 ? ["timers"] : fields
  const object = {
    address: s.address.trim(),
    multihop: s.multihop,
    local_address: s.local_address.trim(),
    interface: s.interface.trim(),
    vrf: s.vrf.trim(),
    profile: s.profile.trim(),
    timers: timers as TypedBfdTimers,
  }
  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? "Add a BFD session" : `BFD session ${editing?.before?.address}`}</DialogTitle>
          <DialogDescription>Empty timers keep FRR&apos;s defaults; a profile&apos;s timers apply where these are empty.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Peer address" value={s.address} onChange={(address) => setS({ ...s, address })} error={isNew ? why.address : null} placeholder="192.0.2.1" />
          <TextField label="Interface" value={s.interface} onChange={(i) => setS({ ...s, interface: i })} placeholder="optional" />
          <TextField label="Local address" value={s.local_address} onChange={(v) => setS({ ...s, local_address: v })} error={why.local_address} placeholder="optional" />
          <TextField label="VRF" value={s.vrf} onChange={(vrf) => setS({ ...s, vrf })} placeholder="default" />
          <TextField label="Profile" value={s.profile} onChange={(p) => setS({ ...s, profile: p })} error={why.profile} placeholder={profiles.length ? profiles.join(", ") : "none"} />
          <div className="flex items-end pb-1">
            <SwitchField label="Multi-hop" checked={s.multihop} onChange={(multihop) => setS({ ...s, multihop })} />
          </div>
        </div>
        <Timers t={s.timers} set={(patch) => setS({ ...s, timers: { ...s.timers, ...patch } })} why={why} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={blocked || (!isNew && fields.length === 0)}
            onClick={() => {
              onStage({
                path: ["bfd"],
                lines: [],
                typed: [typedSet({ bfd_peer: object }, sent)],
                summary: describeSet(sent, { ...object, ...Object.fromEntries(Object.entries(timers).map(([k, v]) => [`timers.${k}`, v])) }),
                label: `${isNew ? "add" : "edit"} BFD peer ${object.address}`,
                key: `bfd ${peerKey(object)}`,
              })
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

function ProfileDialog({
  editing,
  taken,
  onClose,
  onStage,
}: {
  editing: { before?: TypedBfdProfile } | null
  taken: string[]
  onClose: () => void
  onStage: (c: ConfigChange) => void
}) {
  const [name, setName] = useState("")
  const [t, setT] = useState<TimerForm>(timerForm(null))
  const [shownFor, setShownFor] = useState<typeof editing>(null)
  if (editing !== shownFor) {
    setShownFor(editing)
    setName(editing?.before?.name ?? "")
    setT(timerForm(editing?.before?.timers))
  }
  const isNew = !editing?.before
  const why = {
    ...timerProblems(t),
    name: !name.trim() || /\s/.test(name.trim()) ? "one word" : isNew && taken.includes(name.trim()) ? "a profile with this name exists" : null,
  }
  const { fields, timers } = timerDiff(timerForm(editing?.before?.timers), t)
  const sent = isNew && fields.length === 0 ? ["timers"] : fields
  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? "Add a BFD profile" : `BFD profile ${editing?.before?.name}`}</DialogTitle>
          <DialogDescription>A set of timers sessions, BGP neighbors and static routes can name.</DialogDescription>
        </DialogHeader>
        {isNew && <TextField label="Name" value={name} onChange={setName} error={name ? why.name : null} placeholder="fast" />}
        <Timers t={t} set={(patch) => setT({ ...t, ...patch })} why={why} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={Object.values(why).some(Boolean) || (!isNew && fields.length === 0)}
            onClick={() => {
              const object = { name: name.trim(), timers: timers as TypedBfdTimers }
              onStage({
                path: ["bfd"],
                lines: [],
                typed: [typedSet({ bfd_profile: object }, sent)],
                summary: describeSet(sent, Object.fromEntries(Object.entries(timers).map(([k, v]) => [`timers.${k}`, v]))),
                label: `${isNew ? "add" : "edit"} BFD profile ${object.name}`,
                key: `bfd profile ${object.name}`,
              })
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
