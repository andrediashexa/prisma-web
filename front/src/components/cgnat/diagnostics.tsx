"use client"

import { useState } from "react"
import useSWR from "swr"
import { Loader2Icon, SearchIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useFleetStatus } from "@/hooks/use-routers"
import { api, ApiError, errorMessage, fetcher } from "@/lib/api"
import { formatBytes, formatNumber } from "@/lib/format"
import { HA_PEER_PATH_FROM, peerPathError, releaseAtLeast } from "@/lib/release"
import { routerApi } from "@/lib/types"

/* eslint-disable @typescript-eslint/no-explicit-any -- the screens are shown as the router gives them */
type Screen = Record<string, any> & { text?: string }

const SCREENS = [
  ["top", "Top"],
  ["blocks", "Blocks"],
  ["drops", "Drops"],
  ["memory", "Memory"],
  ["algs", "ALGs"],
  ["forwards", "Forwards"],
  ["identity", "Identity"],
  ["ha", "HA"],
  ["history", "History"],
] as const

/** The router's own screen, as it printed it. */
function ScreenText({ text }: { text?: string }) {
  if (!text) return null
  return (
    <details className="text-sm">
      <summary className="text-muted-foreground cursor-pointer text-xs">The router&apos;s screen</summary>
      <pre className="bg-muted/50 mt-2 overflow-x-auto rounded-lg border p-3 font-mono text-xs">{text}</pre>
    </details>
  )
}

function Kv({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-muted-foreground text-xs">{k}</dt>
          <dd className="tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function ScreenView({ name, s }: { name: string; s: Screen }) {
  switch (name) {
    case "top":
      return (
        <>
          <p className="text-muted-foreground text-sm">{formatNumber(s.holding_blocks ?? 0)} subscribers hold blocks; the fullest:</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subscriber</TableHead>
                <TableHead>Pool</TableHead>
                <TableHead className="text-right">Ports used</TableHead>
                <TableHead className="text-right">Full</TableHead>
                <TableHead className="text-right">Blocks</TableHead>
                <TableHead className="text-right">Refusals</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(s.subscribers ?? []).map((t: any) => (
                <TableRow key={t.subscriber}>
                  <TableCell className="font-mono text-sm">{t.subscriber}</TableCell>
                  <TableCell>{t.pool}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(t.ports_used)} / {formatNumber(t.ports_total)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{t.percent_full}%</TableCell>
                  <TableCell className="text-right tabular-nums">{t.blocks}</TableCell>
                  <TableCell className="text-right tabular-nums">{t.refusals}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )
    case "blocks":
      return (
        <>
          {(s.pools ?? []).map((p: any) => (
            <div key={p.pool} className="space-y-2">
              <h4 className="text-sm font-medium">
                Pool {p.pool} <span className="text-muted-foreground font-normal">· hold-down {p.holddown_seconds} s</span>
              </h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Worker</TableHead>
                    <TableHead className="text-right">In use</TableHead>
                    <TableHead className="text-right">Blocks</TableHead>
                    <TableHead className="text-right">Allocations</TableHead>
                    <TableHead className="text-right">Releases</TableHead>
                    <TableHead className="text-right">Refusals</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...(p.workers ?? []).map((w: any) => [`thread ${w.thread}`, w.counts]), ["total", p.total]].map(([k, c]: any) => (
                    <TableRow key={k}>
                      <TableCell>{k}</TableCell>
                      {["in_use", "blocks", "allocations", "releases", "refusals"].map((f) => (
                        <TableCell key={f} className="text-right tabular-nums">
                          {formatNumber(c?.[f] ?? 0)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}
        </>
      )
    case "drops":
      return (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Node</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead className="text-right">Count</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(s.nodes ?? []).flatMap((n: any) =>
              (n.counters ?? []).map((c: any) => (
                <TableRow key={`${n.node}-${c.reason}`}>
                  <TableCell className="font-mono text-xs">{n.node}</TableCell>
                  <TableCell>
                    {c.reason} {c.dropped && <Badge variant="destructive">dropped</Badge>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(c.count)}</TableCell>
                </TableRow>
              )),
            )}
          </TableBody>
        </Table>
      )
    case "memory":
      return (
        <Kv
          items={[
            ["Heap", `${formatBytes(s.heap_used_bytes ?? 0)} of ${formatBytes(s.heap_bytes ?? 0)}`],
            ["Sessions", s.sessions_known ? `${formatNumber(s.sessions)} of ${formatNumber(s.sessions_fit)} that fit` : "not known"],
            ["Refused (no memory)", formatNumber(s.refused_no_memory ?? 0)],
            ["Memory given", s.given ? `${s.given_gb} GB${s.given_in_effect ? "" : " (at the next start)"}` : "default"],
          ]}
        />
      )
    case "algs":
      return (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pool</TableHead>
              <TableHead>Gateways</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(s.pools ?? []).map((p: any) => (
              <TableRow key={p.pool}>
                <TableCell>{p.pool}</TableCell>
                <TableCell className="flex flex-wrap gap-1">
                  {(p.algs ?? []).map((a: any) => (
                    <Badge key={a.alg} variant={a.on ? "secondary" : "outline"} title={a.description}>
                      {a.alg} {a.on ? "on" : "off"}
                    </Badge>
                  ))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )
    case "forwards":
      return (s.forwards ?? []).length === 0 ? (
        <p className="text-muted-foreground text-sm">No port forward.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pool</TableHead>
              <TableHead>Protocol</TableHead>
              <TableHead>Public</TableHead>
              <TableHead>Private</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(s.forwards ?? []).map((f: any) => (
              <TableRow key={`${f.public_address}:${f.public_port}/${f.protocol}`}>
                <TableCell>{f.pool}</TableCell>
                <TableCell>{f.protocol}</TableCell>
                <TableCell className="font-mono text-sm">
                  {f.public_address}:{f.public_port}
                </TableCell>
                <TableCell className="font-mono text-sm">
                  {f.private_address}:{f.private_port}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )
    case "identity":
      return (
        <Kv
          items={[
            ["Identity file", s.loaded ? `${formatNumber(s.entries)} entries${s.read_at ? `, read ${s.read_at}` : ""}` : "none loaded"],
            ["RADIUS", s.radius ? `port ${s.radius_port}` : "off"],
            ["Received / applied", `${formatNumber(s.received ?? 0)} / ${formatNumber(s.applied ?? 0)}`],
            ["Rejected", formatNumber((s.bad_authenticator ?? 0) + (s.malformed ?? 0))],
          ]}
        />
      )
    case "ha":
      return (
        <div className="space-y-2">
          <Kv
            items={[
              ["Dataplane", s.dataplane ? "up" : "down"],
              ["Fingerprint", <span key="f" className="font-mono">{s.fingerprint}</span>],
              ["Peer copy", <span key="p" data-peer-read={s.peer_read ? "yes" : "no"}>{s.peer_read ? "read" : s.peer_unread || "not read"}</span>],
              ...(s.peer_path ? [["Read from", <span key="r" className="font-mono text-xs break-all">{s.peer_path}</span>] as [string, React.ReactNode]] : []),
              ["Agree", s.agree ? "yes" : "no"],
            ]}
          />
          {(s.routers ?? []).map((r: any) => (
            <p key={`${r.interface}-${r.vr_id}`} className="text-sm">
              VRRP {r.interface} vrid {r.vr_id}: <Badge variant="outline">{r.state}</Badge> priority {r.priority_advertised}
            </p>
          ))}
          {(s.divergences ?? []).map((d: any) => (
            <p key={d.pool} className="text-destructive text-sm">
              {d.pool}: here {d.here}, there {d.there}
            </p>
          ))}
        </div>
      )
    case "history":
      return (
        <Kv
          items={[
            ["Verdict", <Badge key="v" variant={s.verdict === "INTACT" ? "secondary" : "destructive"}>{String(s.verdict ?? "").toLowerCase().replaceAll("_", " ")}</Badge>],
            ["Entries checked", formatNumber(s.checked ?? 0)],
            ["File", <span key="p" className="font-mono text-xs">{s.path}</span>],
            ["Head", s.head_seq ? `#${s.head_seq}` : "—"],
          ]}
        />
      )
  }
  return null
}

/**
 * HA (#63), and from Prisma 0.152.11 the peer's copy read from another path: `show cgnat ha
 * peer <file>` (#95). What cannot be read is not an error: the box says why.
 */
function HaTab({ routerId }: { routerId: string }) {
  const release = useFleetStatus().data?.find((r) => r.id === routerId)?.version?.release
  const offered = releaseAtLeast(release, HA_PEER_PATH_FROM)
  const [draft, setDraft] = useState("")
  const [path, setPath] = useState("")
  const error = peerPathError(draft)
  const q = path ? `?${new URLSearchParams({ peer_path: path })}` : ""
  const { data, error: failed, isLoading } = useSWR<Screen>(routerApi(routerId, `/cgnat/ha${q}`), fetcher, { revalidateOnFocus: false })
  return (
    <div className="space-y-3" data-screen="ha">
      {offered && (
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!error) setPath(draft.trim())
          }}
        >
          <div className="min-w-0 flex-1 sm:max-w-md">
            <Input
              aria-label="Peer copy path"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="The default peer copy, or a path on the router"
              className="font-mono text-xs"
              aria-invalid={!!error}
            />
            {error && <p className="text-destructive mt-1 text-xs">{error}</p>}
          </div>
          <Button type="submit" variant="outline" disabled={!!error || draft.trim() === path}>
            <SearchIcon /> Compare
          </Button>
        </form>
      )}
      {isLoading && <Loader2Icon className="text-muted-foreground size-4 animate-spin" />}
      {failed && <p className="text-destructive text-sm">{errorMessage(failed)}</p>}
      {data && (
        <>
          <ScreenView name="ha" s={data} />
          <ScreenText text={data.text} />
        </>
      )}
    </div>
  )
}

function ScreenTab({ routerId, name }: { routerId: string; name: string }) {
  const { data, error, isLoading } = useSWR<Screen>(routerApi(routerId, `/cgnat/${name}`), fetcher, { revalidateOnFocus: false })
  if (isLoading) return <Loader2Icon className="text-muted-foreground size-4 animate-spin" />
  if (error) return <p className="text-destructive text-sm">{errorMessage(error)}</p>
  if (!data) return null
  return (
    <div className="space-y-3" data-screen={name}>
      <ScreenView name={name} s={data} />
      <ScreenText text={data.text} />
    </div>
  )
}

/** Public address and port to the subscriber that used it: an operator's, audited. */
function Lookup({ routerId }: { routerId: string }) {
  const [address, setAddress] = useState("")
  const [port, setPort] = useState("")
  const [result, setResult] = useState<Screen | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function look(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const q = new URLSearchParams({ address: address.trim(), port: port.trim() })
      setResult(await api.get<Screen>(routerApi(routerId, `/cgnat/translation?${q}`)))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3" data-screen="translation">
      <form onSubmit={look} className="flex flex-wrap items-end gap-2">
        <Input aria-label="Public address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="203.0.113.7" className="w-40 font-mono" />
        <Input aria-label="Public port" value={port} onChange={(e) => setPort(e.target.value)} placeholder="40000" className="w-24 font-mono" />
        <Button type="submit" disabled={busy}>
          {busy ? <Loader2Icon className="animate-spin" /> : <SearchIcon />} Who used it
        </Button>
      </form>
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <Kv
            items={[
              ["Subscriber", <span key="s" className="font-mono">{result.subscriber}</span>],
              ["Pool", result.pool],
              ["Block", result.block],
              ["Source", `${String(result.source ?? "").toLowerCase().replaceAll("_", " ")}${result.now_only ? " (now only)" : ""}`],
            ]}
          />
          <ScreenText text={result.text} />
        </>
      )}
    </div>
  )
}

/**
 * The rest of `show cgnat` (Prisma 0.150.3, #63): each screen's fields, and the
 * router's own screen. Not shown on a router without these calls.
 */
export function CgnatDiagnostics({ routerId, canLookup }: { routerId: string; canLookup: boolean }) {
  // One probe: a router before 0.150.3 answers unimplemented, and the card is left out.
  const probe = useSWR<Screen>(routerApi(routerId, "/cgnat/drops"), fetcher, { revalidateOnFocus: false, shouldRetryOnError: false })
  if (probe.error instanceof ApiError && probe.error.code === "router_unimplemented") return null
  if (!probe.data && !probe.error) return null
  return (
    <Card data-cgnat-diagnostics>
      <CardHeader>
        <CardTitle>Diagnostics</CardTitle>
        <CardDescription>The router&apos;s CGNAT screens: who used a public address, the fullest subscribers, blocks, drops and the rest.</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue={canLookup ? "translation" : "top"}>
          <TabsList className="flex-wrap">
            {canLookup && <TabsTrigger value="translation">Lookup</TabsTrigger>}
            {SCREENS.map(([k, label]) => (
              <TabsTrigger key={k} value={k}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {canLookup && (
            <TabsContent value="translation" className="pt-3">
              <Lookup routerId={routerId} />
            </TabsContent>
          )}
          {SCREENS.map(([k]) => (
            <TabsContent key={k} value={k} className="pt-3">
              {k === "ha" ? <HaTab routerId={routerId} /> : <ScreenTab routerId={routerId} name={k} />}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}
