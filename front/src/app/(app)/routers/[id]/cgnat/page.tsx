"use client"

import { useParams } from "next/navigation"
import { useState } from "react"
import useSWR from "swr"
import { Loader2Icon, SearchIcon } from "lucide-react"

import { CgnatWidget } from "@/components/widgets/cgnat-widget"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, errorMessage, fetcher } from "@/lib/api"
import { formatNumber } from "@/lib/format"
import { routerApi, type Pool, type Subscriber } from "@/lib/types"
import { cn } from "@/lib/utils"

export default function CgnatPage() {
  const { id } = useParams<{ id: string }>()
  const { data } = useSWR<{ pools: Pool[] }>(routerApi(id, "/pools"), fetcher, { refreshInterval: 10_000 })

  return (
    <>
      <CgnatWidget routerId={id} title="Sessions and subscribers" />

      <Card className="py-0">
        <CardHeader className="pt-6">
          <CardTitle>Pools</CardTitle>
          <CardDescription>Usage of each public address pool</CardDescription>
        </CardHeader>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Pool</TableHead>
                <TableHead>Prefixes</TableHead>
                <TableHead>Block</TableHead>
                <TableHead className="w-56">Subscribers</TableHead>
                <TableHead className="text-right">Ports in use</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">Refusals</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data && (
                <TableRow>
                  <TableCell colSpan={7} className="pl-6">
                    <Skeleton className="h-16 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {data?.pools.map((p) => {
                const pct = p.capacity > 0 ? (p.subscribers / p.capacity) * 100 : 0
                return (
                  <TableRow key={p.name} className="align-top">
                    <TableCell className="pl-6">
                      <div className="font-medium">{p.name}</div>
                      <div className="mt-1 flex gap-1">
                        <Badge variant="outline">{p.mode}</Badge>
                        <Badge variant="outline">{p.policy}</Badge>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {p.prefixes_inside.map((x) => (
                        <div key={x}>
                          <span className="text-muted-foreground">in </span>
                          {x}
                        </div>
                      ))}
                      {p.prefixes_outside.map((x) => (
                        <div key={x}>
                          <span className="text-muted-foreground">out </span>
                          {x}
                        </div>
                      ))}
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">{p.block_size} ports</TableCell>
                    <TableCell>
                      <div className="flex justify-between text-xs tabular-nums">
                        <span>{formatNumber(p.subscribers)}</span>
                        <span className="text-muted-foreground">
                          of {formatNumber(p.capacity)} ({formatNumber(p.guaranteed)} guaranteed)
                        </span>
                      </div>
                      <div className="bg-muted mt-1.5 h-1.5 overflow-hidden rounded-full">
                        <div
                          className={cn("h-full rounded-full", pct > 90 ? "bg-destructive" : pct > 75 ? "bg-chart-4" : "bg-primary")}
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(p.ports_in_use)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(p.sessions)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", p.refusals > 0 && "text-destructive")}>
                      {formatNumber(p.refusals)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </Card>

      <SubscriberLookup routerId={id} />
    </>
  )
}

function SubscriberLookup({ routerId }: { routerId: string }) {
  const [address, setAddress] = useState("")
  const [result, setResult] = useState<Subscriber | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function search(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      setResult(await api.get<Subscriber>(routerApi(routerId, `/subscriber?address=${encodeURIComponent(address.trim())}`)))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Look up subscriber</CardTitle>
        <CardDescription>Enter the subscriber&apos;s inside address to see the public IP and ports assigned to it</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={search} className="flex max-w-md gap-2">
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="100.64.1.23" className="font-mono" required />
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2Icon className="animate-spin" /> : <SearchIcon />} Search
          </Button>
        </form>
        {error && <p className="text-destructive text-sm">{error}</p>}
        {result && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>
                  <span className="text-muted-foreground">Subscriber </span>
                  <span className="font-mono">{result.address}</span>
                </span>
                <span>
                  <span className="text-muted-foreground">Pool </span>
                  {result.pool}
                </span>
                <span>
                  <span className="text-muted-foreground">Sessions </span>
                  {formatNumber(result.sessions)}
                </span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Public IP</TableHead>
                    <TableHead>Ports</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.blocks.map((b) => (
                    <TableRow key={`${b.public_address}-${b.first_port}`}>
                      <TableCell className="font-mono">{b.public_address}</TableCell>
                      <TableCell className="font-mono tabular-nums">
                        {b.first_port}–{b.last_port}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {result.text && <pre className="bg-muted/50 overflow-x-auto rounded-lg border p-3 font-mono text-xs">{result.text}</pre>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
