"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Loader2Icon, TimerIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { api, errorMessage, fetcher } from "@/lib/api"
import { routerApi, type PendingConfirm } from "@/lib/types"

/** Banner for a `commit confirmed` awaiting confirmation, with a countdown. */
export function PendingConfirmBanner({ routerId }: { routerId: string }) {
  const key = routerApi(routerId, "/config/pending")
  const { data, mutate } = useSWR<{ pending: PendingConfirm | null }>(key, fetcher, { refreshInterval: 5_000 })
  const [now, setNow] = useState(() => Date.now())
  const [confirming, setConfirming] = useState(false)
  const pending = data?.pending

  useEffect(() => {
    if (!pending?.deadline) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pending?.deadline])

  if (!pending) return null

  const left = pending.deadline ? Math.max(0, Math.round((new Date(pending.deadline).getTime() - now) / 1000)) : null
  const clock = left === null ? null : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`

  async function confirm() {
    setConfirming(true)
    try {
      await api.post(routerApi(routerId, "/config/confirm"))
      toast.success("Change confirmed")
      await mutate({ pending: null }, { revalidate: true })
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
      <TimerIcon className="size-5 shrink-0" />
      <div className="flex-1">
        <div className="font-medium">
          Change awaiting confirmation{clock && <span className="ml-2 font-mono tabular-nums">{clock}</span>}
        </div>
        <div className="text-xs opacity-80">
          Commit {pending.revision ?? ""} by {pending.by}. If nobody confirms in time, Prisma rolls back to the previous configuration.
        </div>
      </div>
      {pending.can_confirm && (
        <Button size="sm" onClick={confirm} disabled={confirming}>
          {confirming && <Loader2Icon className="animate-spin" />}
          Confirm change
        </Button>
      )}
    </div>
  )
}
