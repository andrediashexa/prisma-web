"use client"

import useSWR from "swr"
import { TriangleAlertIcon } from "lucide-react"

import { ClearAction, useClears } from "@/components/clear-action"
import { fetcher } from "@/lib/api"
import { routerApi } from "@/lib/types"

interface PendingConfiguration {
  pending: boolean
  cards: string[]
  left_out: string[]
  since: number
  path: string
  held_for_a_commit: boolean
}

/**
 * Part of the saved configuration left out at boot, a card being missing (Prisma 0.151.5, #70):
 * the box applies the rest and reports the gap, and `save` is refused until the statements are
 * applied (the card back) or given up.
 */
export function PendingConfigurationBanner({ routerId, notServing }: { routerId: string; notServing: boolean }) {
  const { data, mutate } = useSWR<PendingConfiguration>(notServing ? routerApi(routerId, "/screens/pending-configuration") : null, fetcher, {
    refreshInterval: 30_000,
  })
  const clears = useClears(routerId)
  if (!notServing) return null
  const since = data?.since ? new Date(data.since * 1000).toLocaleString("en-US") : null
  return (
    <div className="border-destructive/30 bg-destructive/10 space-y-2 rounded-lg border px-4 py-3 text-sm" data-pending-configuration role="alert">
      <p className="text-destructive flex items-center gap-2 font-medium">
        <TriangleAlertIcon className="size-4 shrink-0" />
        Part of the saved configuration is not applied
        {data?.cards.length ? `: ${data.cards.length === 1 ? "card" : "cards"} ${data.cards.join(", ")} missing` : ""}
        {since && ` since ${since}`}.
      </p>
      <p className="text-muted-foreground">
        {data?.held_for_a_commit
          ? "The card came back after a commit: its statements wait for an operator."
          : "The rest of the configuration is applied; these statements apply when the card is back."}{" "}
        Saving is refused until they are applied or given up.
      </p>
      {data && data.left_out.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs">The statements left out ({data.left_out.length})</summary>
          <pre className="bg-background/60 mt-2 overflow-x-auto rounded border p-2 font-mono text-xs">{data.left_out.join("\n")}</pre>
        </details>
      )}
      {clears && (
        <ClearAction
          routerId={routerId}
          target="configuration_pending"
          title="the statements the boot left out"
          label="Give them up"
          disrupts="The statements are dropped: the card's configuration is lost, and saving writes the configuration without it."
          onDone={() => void mutate()}
        />
      )}
    </div>
  )
}
