"use client"

import { useState } from "react"
import useSWR from "swr"

import { ChoiceField, TextField } from "@/components/cgnat/fields"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ApiError, fetcher } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
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
}

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
  const q = new URLSearchParams({ last: /^\d+$/.test(last.trim()) ? last.trim() : "0", since: since.trim(), severity, source })
  const { data, error } = useSWR<{ events: BoxEvent[]; text: string }>(routerApi(routerId, `/events?${q}`), fetcher, { refreshInterval: 30_000 })
  if (error instanceof ApiError && error.status === 501) return null

  return (
    <Card data-box-log>
      <CardHeader>
        <CardTitle>Box log</CardTitle>
        <CardDescription>What happened on the router, as it recorded it: commits, restarts and why, upgrades, boots</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
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
        </div>
        {error && !(error instanceof ApiError && error.status === 501) && (
          <p className="text-destructive text-sm" role="alert">
            {error instanceof Error ? error.message : "The router refused the filter"}
          </p>
        )}
        {!data && !error && <Skeleton className="h-24 w-full" />}
        {data && data.events.length === 0 && <p className="text-muted-foreground text-sm">No event matches.</p>}
        {data && data.events.length > 0 && (
          <ol className="divide-y text-sm">
            {[...data.events].reverse().map((e, i) => (
              <li key={`${e.time}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2" data-event-kind={e.kind}>
                <span className="text-muted-foreground w-40 shrink-0 text-xs tabular-nums">{e.time ? formatDateTime(e.time) : "—"}</span>
                <Badge variant="outline" className={SEVERITY_TONE[e.severity] ?? ""}>
                  {e.severity}
                </Badge>
                <span className="text-muted-foreground text-xs">{e.source}</span>
                <span className="min-w-0 flex-1">{e.text}</span>
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
      </CardContent>
    </Card>
  )
}
