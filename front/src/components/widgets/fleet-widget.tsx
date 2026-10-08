"use client"

import Link from "next/link"
import { ServerIcon, ServerOffIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useFleetStatus } from "@/hooks/use-routers"
import { formatNumber, formatUptime } from "@/lib/format"
import { restartNote } from "@/lib/start-cause"
import { cn } from "@/lib/utils"

/** Every registered router, with state and resources. */
export function FleetWidget() {
  const { data } = useFleetStatus()
  const online = data?.filter((r) => r.online).length ?? 0

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Routers</CardTitle>
        <CardDescription>
          {data ? `${online} of ${data.length} online` : "Polling the routers…"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!data && <Skeleton className="h-28 w-full" />}
        {data?.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No routers registered. <Link href="/routers" className="text-primary underline-offset-4 hover:underline">Add one</Link>
          </p>
        )}
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(15rem,100%),1fr))] *:min-w-0">
          {data?.map((r) => {
            const s = r.system
            const ses = r.sessions
            const occ = ses && ses.sessions_fit > 0 ? (ses.sessions / ses.sessions_fit) * 100 : 0
            return (
              <Link
                key={r.id}
                href={`/routers/${r.id}`}
                className={cn(
                  "group hover:border-primary/50 hover:bg-accent/40 rounded-lg border p-3 transition-colors",
                  !r.online && "border-destructive/40 bg-destructive/5",
                )}
              >
                <div className="flex items-center gap-2">
                  {r.online ? (
                    <ServerIcon className="text-primary size-4" />
                  ) : (
                    <ServerOffIcon className="text-destructive size-4" />
                  )}
                  <span className="truncate font-medium">{r.name}</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "ml-auto",
                      r.health === "not-serving"
                        ? "border-amber-500/40 text-amber-700 dark:text-amber-300"
                        : r.online
                          ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                          : "border-destructive/40 text-destructive",
                    )}
                    title={r.health === "not-serving" ? "The API answers but reports NOT_SERVING: the dataplane's statistics do not answer." : undefined}
                  >
                    {r.busy ? "busy (console)" : r.health === "not-serving" ? "not serving" : r.online ? `${r.latency_ms} ms` : "offline"}
                  </Badge>
                </div>
                {s ? (
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <Metric label="Sessions" value={ses ? formatNumber(ses.sessions) : "—"} pct={occ} />
                    <div>
                      <div className="text-muted-foreground">Subscribers</div>
                      <div className="font-medium tabular-nums">{ses ? formatNumber(ses.subscribers) : "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Uptime</div>
                      <div className="font-medium tabular-nums">{formatUptime(s.uptime_seconds)}</div>
                    </div>
                    {r.version && (
                      <div className="text-muted-foreground col-span-3 truncate">
                        Prisma {r.version.release}
                        {r.log_export === "not-serving" && (
                          <span className="text-destructive" title="A configured CGNAT log stream has had something to send and got nothing out for a minute.">
                            {" "}· log export stalled
                          </span>
                        )}
                        {restartNote(s) && (
                          <span className={restartNote(s)!.tone === "destructive" ? "text-destructive" : "text-amber-600 dark:text-amber-400"} title={restartNote(s)!.long}>
                            {" "}· {restartNote(s)!.short}
                          </span>
                        )}
                        {!r.version.dataplane_current && (
                          <span className="text-amber-600 dark:text-amber-400" title="The upgrade replaced the VTY and the files, but the dataplane (VPP and the CGNAT plugin) only switches to the new version on the next reboot.">
                            {" "}· reboot pending
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-destructive mt-3 line-clamp-2 text-xs">{r.error}</p>
                )}
              </Link>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function Metric({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
      <div className="bg-muted mt-1 h-1 overflow-hidden rounded-full">
        <div
          className={cn("h-full rounded-full", pct > 85 ? "bg-destructive" : pct > 65 ? "bg-chart-4" : "bg-primary")}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  )
}
