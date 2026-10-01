"use client"

import useSWR from "swr"
import { TriangleAlertIcon } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher } from "@/lib/api"
import { formatDateTime, formatSince } from "@/lib/format"
import { routerApi, type SystemInfo } from "@/lib/types"

const PARTS: { key: keyof SystemInfo; label: string; hint: string }[] = [
  { key: "boot_time", label: "Box", hint: "Kernel boot" },
  { key: "dataplane_started", label: "Dataplane", hint: "VPP, by its own clock" },
  { key: "control_plane_started", label: "Routing", hint: "FRR routing daemons" },
  { key: "vty_started", label: "Management", hint: "VTY management container" },
]

/**
 * Since when each part of a Prisma runs (Prisma 0.148.7, #20). A field the box
 * could not read is unset and shown as unknown, never as zero.
 */
export function UptimeWidget({ routerId, title = "Uptime" }: { routerId: string; title?: string }) {
  const { data: sys } = useSWR<SystemInfo>(routerApi(routerId, "/system"), fetcher, { refreshInterval: 30_000 })
  const supported = sys && "boot_time" in sys

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>Since when each part of the router runs</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!sys && <Skeleton className="h-32 w-full" />}
        {sys?.dataplane_restarted && (
          <div className="border-destructive/40 bg-destructive/10 text-destructive flex gap-2 rounded-lg border px-3 py-2 text-sm">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <span>
              The dataplane restarted by itself after the box booted. Every session it carried was dropped at that
              moment.
            </span>
          </div>
        )}
        {sys && !supported && (
          <p className="text-muted-foreground text-sm">This Prisma does not report the uptime breakdown (needs 0.148.7 or newer).</p>
        )}
        {sys && supported && (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {PARTS.map((p) => {
              const at = sys[p.key] as string | null | undefined
              return (
                <div key={p.key} className="rounded-lg border p-3">
                  <dt className="text-muted-foreground text-xs" title={p.hint}>
                    {p.label}
                  </dt>
                  <dd className="font-medium tabular-nums">{at ? formatSince(at) : "unknown"}</dd>
                  <dd className="text-muted-foreground text-xs tabular-nums">{at ? `since ${formatDateTime(at)}` : "not reported by the box"}</dd>
                </div>
              )
            })}
            <div className="rounded-lg border p-3 sm:col-span-2">
              <dt className="text-muted-foreground text-xs">Last boot</dt>
              <dd className="font-mono text-xs">{sys.last_boot_reason || "unknown"}</dd>
              <dt className="text-muted-foreground mt-2 text-xs">Release installed</dt>
              <dd className="text-xs tabular-nums">{sys.release_installed_at ? formatDateTime(sys.release_installed_at) : "unknown"}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  )
}
