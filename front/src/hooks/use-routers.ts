"use client"

import useSWR from "swr"

import { fetcher } from "@/lib/api"
import type { RouterStatus, RouterView } from "@/lib/types"

export function useRouters() {
  return useSWR<RouterView[]>("/routers", fetcher)
}

/** Status of every router; shared by the sidebar, header and widgets. */
export function useFleetStatus() {
  return useSWR<RouterStatus[]>("/routers/status", fetcher, { refreshInterval: 10_000 })
}
