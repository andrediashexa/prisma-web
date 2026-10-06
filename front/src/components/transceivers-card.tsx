"use client"

import useSWR from "swr"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ApiError, fetcher } from "@/lib/api"
import { showLevel, showThresholds, toneOf, type Tone, type TransceiverLevel } from "@/lib/transceiver"
import { routerApi } from "@/lib/types"
import { cn } from "@/lib/utils"

interface Lane {
  lane: number
  bias_ma: TransceiverLevel | null
  tx_power_mw: TransceiverLevel | null
  rx_power_mw: TransceiverLevel | null
}

interface Transceiver {
  name: string
  source: string
  device: string
  status: string
  why: string
  identifier: string
  vendor: string
  part_number: string
  serial_number: string
  wavelength_nm: number
  temperature_c: TransceiverLevel | null
  voltage_v: TransceiverLevel | null
  lanes: Lane[]
}

const TONE: Record<Tone, string> = {
  ok: "",
  warning: "text-amber-700 dark:text-amber-300 font-medium",
  alarm: "text-destructive font-medium",
  unknown: "text-muted-foreground",
}

const STATUS: Record<string, string> = {
  DDM: "diagnostics",
  NO_DDM: "no diagnostics",
  COPPER: "copper",
  ABSENT: "no module",
  UNREADABLE: "unreadable",
}

function Value({ l, unit, label }: { l: TransceiverLevel | null; unit: "°C" | "V" | "mA" | "power"; label: string }) {
  const tone = toneOf(l)
  return (
    <span className={cn("tabular-nums", TONE[tone])} title={`${label}: ${showThresholds(l, unit)}`} data-tone={tone}>
      {showLevel(l, unit)}
      {(tone === "warning" || tone === "alarm") && <span className="sr-only"> ({l?.level.toLowerCase().replace("_", " ")})</span>}
    </span>
  )
}

/**
 * Each port's module (Prisma 0.151.15, #76): its identity and, with diagnostics, its levels
 * against the module's own thresholds. The box reads every module over I2C, so this asks once
 * a minute. Not shown on a box before it (the back answers 501).
 */
export function TransceiversCard({ routerId }: { routerId: string }) {
  const { data, error } = useSWR<{ dataplane_answered: boolean; transceivers: Transceiver[] }>(routerApi(routerId, "/transceivers"), fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
  })
  if (error instanceof ApiError && error.status === 501) return null
  const flagged = (data?.transceivers ?? []).filter((t) =>
    [t.temperature_c, t.voltage_v, ...t.lanes.flatMap((l) => [l.bias_ma, l.tx_power_mw, l.rx_power_mw])].some((l) => ["warning", "alarm"].includes(toneOf(l))),
  )

  return (
    <Card data-transceivers>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Transceivers
          {flagged.length > 0 && <Badge variant="destructive">{flagged.length} past a threshold</Badge>}
        </CardTitle>
        <CardDescription>Each port&apos;s module and its levels against the module&apos;s own thresholds, read once a minute</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && !(error instanceof ApiError && error.status === 501) && (
          <p className="text-destructive text-sm" role="alert">
            {error instanceof Error ? error.message : "The router could not read the modules"}
          </p>
        )}
        {data && !data.dataplane_answered && (
          <p className="text-sm text-amber-700 dark:text-amber-300">The dataplane did not answer: its ports are missing below, the cards Linux owns are there.</p>
        )}
        {!data && !error && <Skeleton className="h-24 w-full" />}
        {data && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Port</TableHead>
                  <TableHead>Module</TableHead>
                  <TableHead className="text-right">Temperature</TableHead>
                  <TableHead className="text-right">Voltage</TableHead>
                  <TableHead className="text-right">Bias</TableHead>
                  <TableHead className="text-right">TX</TableHead>
                  <TableHead className="text-right">RX</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.transceivers.map((t) => {
                  const lanes = t.status === "DDM" && t.lanes.length ? t.lanes : [null]
                  return lanes.map((lane, i) => (
                    <TableRow key={`${t.name}-${i}`} data-transceiver={t.name} className="align-top">
                      {i === 0 && (
                        <>
                          <TableCell rowSpan={lanes.length} className="font-mono text-sm">
                            {t.name}
                            <div className="text-muted-foreground text-xs">{t.source === "linux" ? `Linux card ${t.device}` : t.device}</div>
                          </TableCell>
                          <TableCell rowSpan={lanes.length} className="text-sm">
                            <Badge variant="outline">{STATUS[t.status] ?? t.status.toLowerCase()}</Badge>
                            {t.vendor && (
                              <div className="mt-1">
                                {t.vendor} {t.part_number}
                                {t.wavelength_nm > 0 && <span className="text-muted-foreground"> · {t.wavelength_nm} nm</span>}
                              </div>
                            )}
                            {t.serial_number && <div className="text-muted-foreground text-xs">serial {t.serial_number}</div>}
                            {t.why && <div className="text-muted-foreground text-xs">{t.why}</div>}
                          </TableCell>
                          <TableCell rowSpan={lanes.length} className="text-right text-sm">
                            {t.status === "DDM" ? <Value l={t.temperature_c} unit="°C" label="Temperature" /> : "—"}
                          </TableCell>
                          <TableCell rowSpan={lanes.length} className="text-right text-sm">
                            {t.status === "DDM" ? <Value l={t.voltage_v} unit="V" label="Voltage" /> : "—"}
                          </TableCell>
                        </>
                      )}
                      <TableCell className="text-right text-sm">{lane ? <Value l={lane.bias_ma} unit="mA" label="Laser bias" /> : "—"}</TableCell>
                      <TableCell className="text-right text-sm">{lane ? <Value l={lane.tx_power_mw} unit="power" label="TX power" /> : "—"}</TableCell>
                      <TableCell className="text-right text-sm" data-rx>
                        {lane ? <Value l={lane.rx_power_mw} unit="power" label="RX power" /> : "—"}
                      </TableCell>
                    </TableRow>
                  ))
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
