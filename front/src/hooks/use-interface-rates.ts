"use client"

import useSWR from "swr"

import { api } from "@/lib/api"
import { knownSpeed } from "@/lib/format"
import { routerApi, type RouterInterface, type TrafficSeries } from "@/lib/types"

export interface InterfaceRate {
  rx_bps: number
  tx_bps: number
}

/**
 * The latest rate of each interface with a known link speed, from the same
 * telemetry the traffic chart draws (#25). Interfaces whose speed is unknown
 * are not fetched: they get no utilization anyway.
 */
export function useInterfaceRates(routerId: string, interfaces: RouterInterface[] | undefined) {
  const names = (interfaces ?? []).filter((i) => i.link_up && knownSpeed(i.speed_bps) !== null).map((i) => i.name)
  return useSWR<Record<string, InterfaceRate>>(
    names.length ? ["interface-rates", routerId, ...names] : null,
    async ([, id, ...ifaces]: string[]) => {
      const series = await Promise.all(
        ifaces.map((n) =>
          api
            .get<TrafficSeries>(routerApi(id, `/metrics/traffic?interface=${encodeURIComponent(n)}&minutes=1`))
            .catch(() => null),
        ),
      )
      const out: Record<string, InterfaceRate> = {}
      series.forEach((s, k) => {
        const last = s?.live ? s.samples.at(-1) : undefined
        if (last) out[ifaces[k]] = { rx_bps: last.rx_bps, tx_bps: last.tx_bps }
      })
      return out
    },
    { refreshInterval: 5_000, keepPreviousData: true },
  )
}
