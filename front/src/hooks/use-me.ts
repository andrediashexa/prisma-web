"use client"

import useSWR from "swr"

import { fetcher } from "@/lib/api"
import type { CurrentUser } from "@/lib/types"

export function useMe() {
  return useSWR<CurrentUser>("/auth/me", fetcher, { revalidateOnFocus: true })
}
