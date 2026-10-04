"use client"

import { useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { DownloadIcon, Loader2Icon, PlayIcon, SquareIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ApiError, errorMessage, fetcher } from "@/lib/api"
import { formatNumber } from "@/lib/format"
import { readEvents } from "@/lib/sse"
import { routerApi } from "@/lib/types"

// The rest of the VTY's screens and the probes (Prisma 0.150.6, #64).

/* eslint-disable @typescript-eslint/no-explicit-any -- the screens are shown as the router gives them */
type Screen = Record<string, any> & { text?: string }

/** A screen; `hidden` on a router without the call (before 0.150.6). */
function useScreen(routerId: string, name: string) {
  const r = useSWR<Screen>(routerApi(routerId, `/screens/${name}`), fetcher, { revalidateOnFocus: false, shouldRetryOnError: false })
  const hidden = r.error instanceof ApiError && r.error.code === "router_unimplemented"
  return { ...r, hidden }
}

function ScreenText({ text }: { text?: string }) {
  if (!text) return null
  return (
    <details className="text-sm">
      <summary className="text-muted-foreground cursor-pointer text-xs">The router&apos;s screen</summary>
      <pre className="bg-muted/50 mt-2 overflow-x-auto rounded-lg border p-3 font-mono text-xs">{text}</pre>
    </details>
  )
}

function ScreenCard({
  title,
  description,
  routerId,
  name,
  children,
}: {
  title: string
  description: string
  routerId: string
  name: string
  children: (s: Screen) => React.ReactNode
}) {
  const { data, error, hidden } = useScreen(routerId, name)
  if (hidden || (!data && !error)) return null
  return (
    <Card data-screen={name}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="text-destructive text-sm">{errorMessage(error)}</p>
        ) : data && data.answered === false ? (
          <p className="text-muted-foreground text-sm">The daemon did not answer.</p>
        ) : (
          data && children(data)
        )}
        <ScreenText text={data?.text} />
      </CardContent>
    </Card>
  )
}

/** OSPF's interfaces, with the MTU ospfd advertises beside the dataplane's. */
export function OspfInterfacesCard({ routerId }: { routerId: string }) {
  return (
    <ScreenCard routerId={routerId} name="ospf-interfaces" title="OSPF interfaces" description="Area, state, cost and neighbors; an MTU that differs from the dataplane's stalls the adjacency.">
      {(s) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Interface</TableHead>
              <TableHead>Area</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Neighbors</TableHead>
              <TableHead>MTU</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(s.interfaces ?? []).map((i: any) => (
              <TableRow key={i.name} data-interface={i.name}>
                <TableCell className="font-mono text-sm">
                  {i.name} {i.passive && <Badge variant="outline">passive</Badge>}
                </TableCell>
                <TableCell>{i.area}</TableCell>
                <TableCell>{i.state}</TableCell>
                <TableCell className="text-right tabular-nums">{i.cost < 0 ? "—" : i.cost}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {i.adjacent}/{i.neighbors}
                </TableCell>
                <TableCell className="tabular-nums">
                  {i.ospf_mtu || "—"}
                  {i.dataplane_mtu_known && ` / ${i.dataplane_mtu}`}
                  {i.mtu_stall && (
                    <Badge variant="destructive" className="ml-2">
                      MTU mismatch
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </ScreenCard>
  )
}

export function IsisInterfacesCard({ routerId }: { routerId: string }) {
  return (
    <ScreenCard routerId={routerId} name="isis-interfaces" title="IS-IS circuits" description="The circuits, their level and metric, and whether OSI frames reach the router.">
      {(s) => (
        <>
          {(s.circuits ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No IS-IS circuit.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Interface</TableHead>
                  <TableHead>Area</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead className="text-right">Metric</TableHead>
                  <TableHead className="text-right">Neighbors</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(s.circuits ?? []).map((c: any) => (
                  <TableRow key={`${c.area}-${c.name}`}>
                    <TableCell className="font-mono text-sm">
                      {c.name} {c.passive && <Badge variant="outline">passive</Badge>} {c.silent && <Badge variant="outline">silent</Badge>}
                    </TableCell>
                    <TableCell>{c.area}</TableCell>
                    <TableCell>{c.state}</TableCell>
                    <TableCell>{c.level}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.metric < 0 ? "—" : c.metric}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.active_neighbors}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {s.punt_known && (
            <p className="text-muted-foreground text-xs">
              OSI frames {s.punting ? "reach the router" : "are not punted to the router"}; {formatNumber(s.osi_drops ?? 0)} dropped.
            </p>
          )}
        </>
      )}
    </ScreenCard>
  )
}

export function RoutingLoggingCard({ routerId }: { routerId: string }) {
  const target = (t: any) => (t?.enabled ? [t.level, t.facility && `facility ${t.facility}`, t.filename].filter(Boolean).join(", ") : "off")
  return (
    <ScreenCard routerId={routerId} name="routing-logging" title="Routing logging" description="How each routing daemon logs (FRR's logging; the CGNAT log export is on the CGNAT tab).">
      {(s) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Daemon</TableHead>
              <TableHead>Syslog</TableHead>
              <TableHead>File</TableHead>
              <TableHead>Stdout</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(s.daemons ?? []).map((d: any) => (
              <TableRow key={d.daemon}>
                <TableCell className="font-mono text-sm">{d.daemon}</TableCell>
                <TableCell>{target(d.syslog)}</TableCell>
                <TableCell>{target(d.file)}</TableCell>
                <TableCell>{target(d.stdout)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </ScreenCard>
  )
}

export function HardwareCard({ routerId }: { routerId: string }) {
  return (
    <ScreenCard routerId={routerId} name="hardware" title="Hardware" description="The network cards the host has, those the dataplane holds, and the one the default route leaves by.">
      {(s) => (
        <>
          {!s.dataplane_answered && <p className="text-muted-foreground text-xs">The dataplane could not be asked which cards it holds.</p>}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Card</TableHead>
                <TableHead>PCI</TableHead>
                <TableHead>Driver</TableHead>
                <TableHead>Link</TableHead>
                <TableHead className="text-right">Speed</TableHead>
                <TableHead>MAC</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(s.nics ?? []).map((n: any) => (
                <TableRow key={n.pci || n.name}>
                  <TableCell className="font-mono text-sm">
                    {n.name} {(s.dataplane_holds ?? []).includes(n.name) && <Badge variant="secondary">dataplane</Badge>}{" "}
                    {n.default_route && <Badge variant="outline">default route</Badge>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{n.pci}</TableCell>
                  <TableCell>{n.driver}</TableCell>
                  <TableCell>{n.link}</TableCell>
                  <TableCell className="text-right tabular-nums">{n.speed_mbps ? `${formatNumber(n.speed_mbps)} Mb/s` : "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{n.mac}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </ScreenCard>
  )
}

/** The MIB and the Zabbix template, with the router's enterprise number in them. */
export function SnmpFiles({ routerId }: { routerId: string }) {
  const { hidden, data, error } = useScreen(routerId, "hardware")
  if (hidden || (!data && !error)) return null
  return (
    <Card data-snmp-files>
      <CardHeader>
        <CardTitle>SNMP files</CardTitle>
        <CardDescription>The router&apos;s MIB, and a Zabbix 7.0 template for it, with its enterprise number.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" asChild>
          <a href={`/api${routerApi(routerId, "/snmp-file?kind=mib")}`} download>
            <DownloadIcon /> MIB
          </a>
        </Button>
        <Button variant="outline" asChild>
          <a href={`/api${routerApi(routerId, "/snmp-file?kind=zabbix")}`} download>
            <DownloadIcon /> Zabbix template
          </a>
        </Button>
      </CardContent>
    </Card>
  )
}

type ProbeLine = { line: string; reply?: any; hop?: any; mtr_hop?: any; end?: any }

/**
 * Ping, traceroute and mtr, each line as the router prints it (Prisma 0.150.6, #64).
 * Stopping or leaving the page ends the probe on the router.
 */
export function ProbePanel({ routerId }: { routerId: string }) {
  const probeable = useScreen(routerId, "hardware")
  const [tool, setTool] = useState("ping")
  const [host, setHost] = useState("")
  const [count, setCount] = useState("")
  const [source, setSource] = useState("")
  const [lines, setLines] = useState<ProbeLine[]>([])
  const [end, setEnd] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => abort.current?.abort(), [])
  if (probeable.hidden || (!probeable.data && !probeable.error)) return null

  function stop() {
    abort.current?.abort()
    abort.current = null
    setRunning(false)
  }

  async function run(e: React.FormEvent) {
    e.preventDefault()
    stop()
    const ctl = new AbortController()
    abort.current = ctl
    setLines([])
    setEnd(null)
    setError(null)
    setRunning(true)
    try {
      const res = await fetch(`/api${routerApi(routerId, `/probe/${tool}`)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: host.trim(), count: Number(count.trim() || 0), source: source.trim() }),
        signal: ctl.signal,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error?.message ?? `Error ${res.status}`)
      }
      await readEvents(res, (event, data) => {
        if (event === "probe") {
          const p = JSON.parse(data) as ProbeLine
          if (p.end) setEnd(p.end)
          if (p.line) setLines((xs) => [...xs, p].slice(-500))
        } else if (event === "error") setError(data)
      })
    } catch (err) {
      if (!ctl.signal.aborted) setError(err instanceof Error ? err.message : "The probe failed")
    } finally {
      if (abort.current === ctl) {
        abort.current = null
        setRunning(false)
      }
    }
  }

  return (
    <Card data-probe>
      <CardHeader>
        <CardTitle>Network probes</CardTitle>
        <CardDescription>Ping, traceroute and mtr from the router, a line at a time. One at a time; the router stops one after 5 minutes.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={run} className="flex flex-wrap items-end gap-2">
          <Select value={tool} onValueChange={setTool}>
            <SelectTrigger className="h-9 w-32" aria-label="Probe">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ping">ping</SelectItem>
              <SelectItem value="traceroute">traceroute</SelectItem>
              <SelectItem value="mtr">mtr</SelectItem>
            </SelectContent>
          </Select>
          <Input aria-label="Host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="2001:db8::1 or example.net" className="w-56 font-mono" required />
          <Input aria-label="Count" value={count} onChange={(e) => setCount(e.target.value)} placeholder="5" className="w-20 font-mono" />
          <Input aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="source (optional)" className="w-40 font-mono" />
          {running ? (
            <Button key="stop" type="button" variant="outline" onClick={stop}>
              <SquareIcon /> Stop
            </Button>
          ) : (
            <Button key="run" type="submit">
              <PlayIcon /> Run
            </Button>
          )}
          {running && <Loader2Icon className="text-muted-foreground size-4 animate-spin" />}
        </form>
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        {lines.length > 0 && (
          <pre className="bg-muted/50 max-h-80 overflow-auto rounded-lg border p-3 font-mono text-xs" data-probe-lines>
            {lines.map((l) => l.line).join("\n")}
          </pre>
        )}
        {end && end.transmitted > 0 && (
          <p className="text-sm" data-probe-end>
            {end.received} of {end.transmitted} answered ({end.loss_percent ?? 0}% loss)
            {end.rtt_known && `, ${end.rtt_min_ms}/${end.rtt_avg_ms}/${end.rtt_max_ms} ms min/avg/max`}
            {end.stopped_at_deadline && " — stopped by the router after 5 minutes"}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
