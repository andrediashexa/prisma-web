"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import useSWR from "swr"

import { ChoiceField, TextField } from "@/components/cgnat/fields"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { ApiError, fetcher } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import { readEvents } from "@/lib/sse"
import { routerApi } from "@/lib/types"

interface BoxEvent {
  time: string | null
  severity: string
  source: string
  text: string
  account: string
  origin: string
  kind: string
  component: string
  cause: string
  /** Prisma 0.152.0 (#78): what it is about, and why. */
  subject?: string
  reason?: string
}

/** The kinds the box records (0.151.14, and what it sees happen since 0.152.0, #78). */
const KINDS: [string, string][] = [
  ["", "All"],
  ["commit", "Commits"],
  ["rollback", "Rollbacks"],
  ["confirm", "Confirms"],
  ["confirm-expired", "Confirms expired"],
  ["asked", "Actions asked"],
  ["start", "Starts"],
  ["boot", "Boots"],
  ["upgraded", "Upgrades"],
  ["link", "Links"],
  ["transceiver", "Transceivers"],
  ["bgp", "BGP"],
  ["bfd", "BFD"],
  ["pool", "Pools"],
  ["collector", "Log export"],
  ["login", "Logins"],
  ["settings", "Settings"],
  ["gave-up", "Gave up"],
  // 0.152.7 (#84): a VRF move whose wait for FRR ran out.
  ["vrf-settle", "VRF settle"],
]

/** A remote syslog destination of the box's record and how sending to it goes (Prisma 0.152.2, #79). */
interface LogDestination {
  destination: { address: string; port: number; protocol: string; severity: string; source_address: string; vrf: string } | null
  known: boolean
  state: string
  error: string
  sent: number
  last_sent: string | null
}

/** Said once a boot: what already stood when the box's watcher first read it (0.152.2, #79). */
const STANDING = "standing at start: "

const SEVERITY_TONE: Record<string, string> = {
  error: "border-destructive/50 text-destructive",
  warning: "border-amber-500/50 text-amber-700 dark:text-amber-300",
}

/**
 * `show log` (Prisma 0.151.14, #75): the box's record of what happened on it (commits, rollbacks,
 * confirm expiries, restarts asked and the starts they caused, upgrades, boots), with its
 * filters, newest first. Not shown on a box before it (the back answers 501).
 */
export function BoxLogWidget({ routerId }: { routerId: string }) {
  const [last, setLast] = useState("20")
  const [since, setSince] = useState("")
  const [severity, setSeverity] = useState("")
  const [source, setSource] = useState("")
  const [kind, setKind] = useState("")
  const q = new URLSearchParams({ last: /^\d+$/.test(last.trim()) ? last.trim() : "0", since: since.trim(), severity, source, ...(kind && { kind }) })
  const { data, error } = useSWR<{ events: BoxEvent[]; text: string }>(routerApi(routerId, `/events?${q}`), fetcher, { refreshInterval: 30_000 })
  const { data: sys } = useSWR<{ logging?: LogDestination[] }>(routerApi(routerId, "/system"), fetcher, { refreshInterval: 30_000 })
  // Follow (`monitor log`, 0.152.2, #79): each event as it is written, the card's filters but
  // the number and the time, which only say what is sent first.
  const [follow, setFollow] = useState(false)
  const [live, setLive] = useState<BoxEvent[]>([])
  const [streaming, setStreaming] = useState(false)
  const [followError, setFollowError] = useState<string | null>(null)
  const watch = new URLSearchParams({ severity, source, ...(kind && { kind }) }).toString()
  useEffect(() => {
    if (!follow) return
    const ctl = new AbortController()
    void (async () => {
      try {
        const res = await fetch(`/api${routerApi(routerId, `/events/watch?${watch}`)}`, { credentials: "same-origin", signal: ctl.signal })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          setFollowError(body?.error?.message ?? `Error ${res.status}`)
          return
        }
        await readEvents(res, (event, payload) => {
          if (event === "open") setStreaming(true)
          if (event === "error") setFollowError(payload)
          if (event === "event") setLive((xs) => [...xs, JSON.parse(payload) as BoxEvent].slice(-200))
        })
      } catch {
        // Aborted when the switch goes off or the page leaves.
      } finally {
        setStreaming(false)
      }
    })()
    return () => ctl.abort()
  }, [follow, routerId, watch])
  if (error instanceof ApiError && error.status === 501) return null
  // Streamed events can arrive out of time order (the box appends some late): sorted by time.
  const shown = [...(data?.events ?? []), ...live.filter((l) => !(data?.events ?? []).some((e) => e.time === l.time && e.text === l.text))].sort(
    (a, b) => (b.time ?? "").localeCompare(a.time ?? ""),
  )
  const destinations = sys?.logging ?? []

  return (
    <Card data-box-log>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">Box log {streaming && <Badge variant="outline">live</Badge>}</CardTitle>
        <CardDescription>What happened on the router, as it recorded it: commits, restarts and why, upgrades, boots</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
          <TextField label="Last" value={last} numeric placeholder="50" onChange={setLast} />
          <TextField label="Since" value={since} placeholder="1h, 2d, 2026-10-05" onChange={setSince} />
          <ChoiceField
            label="Severity"
            value={severity}
            onChange={setSeverity}
            options={[
              ["", "All"],
              ["error", "Errors"],
              ["warning", "Warnings and above"],
              ["notice", "Notices and above"],
              ["info", "Info and above"],
            ]}
          />
          <ChoiceField
            label="Source"
            value={source}
            onChange={setSource}
            options={[
              ["", "All"],
              ["vty", "VTY"],
              ["api", "API"],
              ["host", "Host"],
              ["dataplane", "Dataplane"],
              ["routing", "Routing"],
            ]}
          />
          <ChoiceField label="Kind" value={kind} onChange={setKind} options={KINDS} />
        </div>
        <div className="flex items-center gap-2">
          <Switch id={`follow-${routerId}`} checked={follow} onCheckedChange={(on) => {
              setLive([])
              setFollowError(null)
              setFollow(on)
            }}
            aria-label="Follow"
          />
          <Label htmlFor={`follow-${routerId}`} className="text-sm">
            Follow: add each event as the router records it
          </Label>
        </div>
        {followError && (
          <p className="text-destructive text-sm" role="alert" data-follow-error>
            {followError}
          </p>
        )}
        {error && !(error instanceof ApiError && error.status === 501) && (
          <p className="text-destructive text-sm" role="alert">
            {error instanceof Error ? error.message : "The router refused the filter"}
          </p>
        )}
        {!data && !error && <Skeleton className="h-24 w-full" />}
        {data && shown.length === 0 && <p className="text-muted-foreground text-sm">No event matches.</p>}
        {data && shown.length > 0 && (
          <ol className="divide-y text-sm">
            {shown.map((e, i) => (
              <li key={`${e.time}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2" data-event-kind={e.kind}>
                <span className="text-muted-foreground w-40 shrink-0 text-xs tabular-nums">{e.time ? formatDateTime(e.time) : "—"}</span>
                <Badge variant="outline" className={SEVERITY_TONE[e.severity] ?? ""}>
                  {e.severity}
                </Badge>
                <span className="text-muted-foreground text-xs">{e.source}</span>
                {/* On a phone the text has its own line, and a long word breaks (#80). */}
                <span className="min-w-0 basis-full [overflow-wrap:anywhere] sm:flex-1 sm:basis-0">
                  {e.text.startsWith(STANDING) && (
                    <Badge variant="secondary" className="mr-1.5" title="Already so when the router's watcher first read it after its boot" data-standing>
                      standing at start
                    </Badge>
                  )}
                  {e.subject && <span className="mr-1.5 font-mono text-xs" data-subject>{e.subject}</span>}
                  {e.text.startsWith(STANDING) ? e.text.slice(STANDING.length) : e.text}
                  {e.reason && !e.text.includes(e.reason) && <span className="text-muted-foreground"> — {e.reason}</span>}
                </span>
                {(e.account || e.origin) && (
                  <span className="text-muted-foreground text-xs">
                    {e.account}
                    {e.account && e.origin && " · "}
                    {e.origin}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        {sys && "logging" in sys && (
          <section className="space-y-2 border-t pt-3 text-sm" data-log-destinations>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">Sent to remote syslog</h3>
              <Link
                href={`/routers/${routerId}/settings?at=${encodeURIComponent("system > logging")}`}
                className="text-primary text-xs underline-offset-4 hover:underline"
              >
                Edit in Settings
              </Link>
            </div>
            {destinations.length === 0 && <p className="text-muted-foreground text-xs">Nowhere: the record stays on the router.</p>}
            {destinations.map((d, i) => (
              <div key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-destination={d.destination?.address}>
                <span className="font-mono text-xs">
                  {d.destination?.address}:{d.destination?.port} {d.destination?.protocol}
                </span>
                <Badge variant="outline" className={d.state === "not reached" ? SEVERITY_TONE.error : ""}>
                  {d.known ? d.state : "not known"}
                </Badge>
                {d.known && d.error && <span className="text-destructive text-xs">{d.error}</span>}
                {d.known && (
                  <span className="text-muted-foreground text-xs">
                    {d.sent} sent{d.last_sent && `, the last ${formatDateTime(d.last_sent)}`} · {d.destination?.severity} and above
                  </span>
                )}
              </div>
            ))}
          </section>
        )}
      </CardContent>
    </Card>
  )
}
