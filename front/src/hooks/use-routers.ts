"use client"

import useSWR from "swr"

import { fetcher } from "@/lib/api"
import { isReadOnly, type Role, type RouterStatus, type RouterView } from "@/lib/types"

export function useRouters() {
  return useSWR<RouterView[]>("/routers", fetcher)
}

/** Status of every router; shared by the sidebar, header and widgets. */
export function useFleetStatus() {
  return useSWR<RouterStatus[]>("/routers/status", fetcher, { refreshInterval: 10_000 })
}

/** The box's account for this router and whether it can change anything (#28). */
export function useRouterAccess(id: string) {
  const { data } = useFleetStatus()
  const access = data?.find((r) => r.id === id)?.access ?? null
  const readOnly = isReadOnly(access)
  const reason = readOnly && access ? `The account ${access.account} on this router is ${access.role}: changes are disabled.` : null
  return { access, readOnly, reason }
}

/** Whether the router has Prisma 0.149.25's calls (Clear, WatchLogging): its SystemService answers health (#48). */
export function useHasSystemService(id: string) {
  const { data } = useFleetStatus()
  return !!data?.find((r) => r.id === id)?.system_service
}

/** The signed-in user's role on this router (#6). */
export function useRouterRole(id: string): Role | undefined {
  const { data } = useRouters()
  return data?.find((r) => r.id === id)?.my_role
}
