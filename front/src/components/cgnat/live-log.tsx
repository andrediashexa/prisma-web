"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2Icon, PlayIcon, SquareIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatNumber } from "@/lib/format"
import { readEvents } from "@/lib/sse"
import { routerApi, type WatchedLogEvent } from "@/lib/types"

/** Events kept on the page; older ones drop off. */
const KEEP = 500

type Filters = { subscriber: string; public_address: string; port: string; event: string; pool: string }

const EMPTY: Filters = { subscriber: "", public_address: "", port: "", event: "", pool: "" }

/**
 * The CGNAT log, live (Prisma 0.149.25, #49): the VTY's `monitor cgnat logging`
 * through `WatchLogging`. Who had which public address and ports, as the box
 * exports it, with the log export's deliveries and what this reader missed.
 * A watch ends by itself after 30 minutes; stopping or leaving the page ends it on the box.
 */
export function LiveLog({ routerId, pools }: { routerId: string; pools: string[] }) {
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [events, setEvents] = useState<WatchedLogEvent[]>([])
  const [state, setState] = useState<"idle" | "starting" | "watching">("idle")
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => abort.current?.abort(), [])

  function stop() {
    abort.current?.abort()
    abort.current = null
    setState("idle")
  }

  async function start() {
    stop()
    const ctl = new AbortController()
    abort.current = ctl
    setEvents([])
    setError(null)
    setNote(null)
    setState("starting")
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) if (v.trim()) q.set(k, v.trim())
    try {
      const res = await fetch(`/api${routerApi(routerId, `/logging/watch?${q}`)}`, { credentials: "same-origin", signal: ctl.signal })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error?.message ?? `Error ${res.status}`)
      }
      setState("watching")
      await readEvents(res, (event, data) => {
        if (event === "log") {
          const e = JSON.parse(data) as WatchedLogEvent
          if (e.kind === "STARTED") setNote(e.from_watch_ring ? "Watching the box's observation ring." : "Watching.")
          setEvents((xs) => [e, ...xs].slice(0, KEEP))
        } else if (event === "error") setError(data)
        else if (event === "end") setNote("The watch ended (it lasts at most 30 minutes). Start it again to go on.")
      })
    } catch (err) {
      if (!ctl.signal.aborted) setError(err instanceof Error ? err.message : "The watch failed")
    } finally {
      if (abort.current === ctl) {
        abort.current = null
        setState("idle")
      }
    }
  }

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }))
  const watching = state !== "idle"

  return (
    <Card data-live-log>
      <CardHeader>
        <CardTitle>Live log</CardTitle>
        <CardDescription>
          The port blocks the router hands out and takes back, as it exports them, with what each log stream delivered. Recorded in the
          audit log; a watch lasts at most 30 minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void start()
          }}
        >
          <Field label="Subscriber">
            <Input aria-label="Subscriber" value={filters.subscriber} onChange={(e) => set({ subscriber: e.target.value })} placeholder="100.64.0.1" className="w-36 font-mono" />
          </Field>
          <Field label="Public address">
            <Input aria-label="Public address" value={filters.public_address} onChange={(e) => set({ public_address: e.target.value })} placeholder="203.0.113.7" className="w-36 font-mono" />
          </Field>
          <Field label="Port">
            <Input aria-label="Port" value={filters.port} onChange={(e) => set({ port: e.target.value })} placeholder="40000" className="w-24 font-mono" />
          </Field>
          <Field label="Event">
            <Select value={filters.event || "all"} onValueChange={(v) => set({ event: v === "all" ? "" : v })}>
              <SelectTrigger className="h-9 w-32" aria-label="Event">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">every event</SelectItem>
                <SelectItem value="alloc">allocations</SelectItem>
                <SelectItem value="release">releases</SelectItem>
                <SelectItem value="exhausted">exhaustion</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Pool">
            <Select value={filters.pool || "all"} onValueChange={(v) => set({ pool: v === "all" ? "" : v })}>
              <SelectTrigger className="h-9 w-36" aria-label="Pool">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">every pool</SelectItem>
                {pools.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {watching ? (
            // Keyed apart: the click on Stop must not land on Watch's submit once it re-renders.
            <Button key="stop" type="button" variant="outline" onClick={stop}>
              {state === "starting" ? <Loader2Icon className="animate-spin" /> : <SquareIcon />} Stop
            </Button>
          ) : (
            <Button key="watch" type="submit">
              <PlayIcon /> Watch
            </Button>
          )}
        </form>
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        {note && <p className="text-muted-foreground text-sm">{note}</p>}
        {events.length > 0 && (
          <div className="max-h-[28rem] overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Time</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Subscriber</TableHead>
                  <TableHead>Public address and ports</TableHead>
                  <TableHead className="pr-4">Pool</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e, i) => (
                  <EventRow key={events.length - i} e={e} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

const KIND_TONE: Record<string, string> = {
  ALLOC: "bg-chart-2/15 text-chart-2",
  RELEASE: "bg-muted text-muted-foreground",
  EXHAUSTED: "bg-destructive/15 text-destructive",
  LOST: "bg-destructive/15 text-destructive",
}

function EventRow({ e }: { e: WatchedLogEvent }) {
  const time = e.at ? new Date(e.at).toLocaleTimeString("en-US", { hour12: false }) : ""
  const badge = (
    <Badge variant="secondary" className={KIND_TONE[e.kind]}>
      {e.kind.toLowerCase()}
    </Badge>
  )
  let what: React.ReactNode
  if (e.kind === "LOST") what = `${formatNumber(e.lost)} events missed: this reader fell behind the box`
  else if (e.kind === "DELIVERY")
    what = `${e.stream}${e.collector ? ` to ${e.collector}` : ""}: ${formatNumber(e.sent)} sent, ${formatNumber(e.lost)} lost${e.pending_bytes ? `, ${formatNumber(e.pending_bytes)} bytes waiting` : ""}`
  else if (e.kind === "BOOT") what = e.boot_time ? `the dataplane booted at ${new Date(e.boot_time).toLocaleString("en-US")}` : "the dataplane booted"
  else if (e.kind === "STARTED") what = e.pools_named ? "watch started" : "watch started (pools by number: the box does not know their names)"
  if (what !== undefined || e.text) {
    return (
      <TableRow data-kind={e.kind}>
        <TableCell className="pl-4 font-mono text-xs tabular-nums">{time}</TableCell>
        <TableCell>{badge}</TableCell>
        <TableCell colSpan={3} className="text-muted-foreground pr-4 text-sm">
          {what ?? e.text}
        </TableCell>
      </TableRow>
    )
  }
  return (
    <TableRow data-kind={e.kind}>
      <TableCell className="pl-4 font-mono text-xs tabular-nums">{time}</TableCell>
      <TableCell>{badge}</TableCell>
      <TableCell className="font-mono text-sm">{e.subscriber}</TableCell>
      <TableCell className="font-mono text-sm">
        {e.public_address}
        {e.port_first ? `:${e.port_first}–${e.port_last}` : ""}
      </TableCell>
      <TableCell className="pr-4">{e.pool || (e.pool_id ? `#${e.pool_id}` : "")}</TableCell>
    </TableRow>
  )
}
