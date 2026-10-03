"use client"

import { useState } from "react"
import { toast } from "sonner"

import { discardCandidate } from "@/components/config/change-review"
import { api, ApiError, errorMessage } from "@/lib/api"
import { routerApi, type Diagnostic, type OpenCandidateResponse } from "@/lib/types"

/** A change waiting for review: lines at a path, as one Edit. */
export interface ConfigChange {
  path: string[]
  lines: string[]
  /** What it does, for the list. */
  label: string
  /** Changes one form staged together: staging the group again replaces them. */
  group?: string
  /** What the user should know before the review (a remap), shown with the change. */
  warning?: string
}

/** The VTY refused one of the changes while it was applied to the candidate. */
export interface ChangeRefusal {
  message: string
  items: Diagnostic[]
  change: ConfigChange
}

/**
 * Changes staged from forms (#39, #41): kept in the browser until the user
 * reviews them, then applied in order to one candidate, which goes to
 * ChangeReview. Nothing reaches the router before the review.
 */
export function useConfigChanges(routerId: string) {
  const [staged, setStaged] = useState<ConfigChange[]>([])
  const [preparing, setPreparing] = useState(false)
  const [refusal, setRefusal] = useState<ChangeRefusal | null>(null)
  const [reviewing, setReviewing] = useState<string | null>(null)

  /** Adds changes; with a group, they replace what that group staged before. */
  function stage(changes: ConfigChange | ConfigChange[], group?: string) {
    const list = (Array.isArray(changes) ? changes : [changes]).filter((c) => c.lines.length > 0).map((c) => ({ ...c, group: group ?? c.group }))
    setStaged((s) => [...(group ? s.filter((c) => c.group !== group) : s), ...list])
    setRefusal(null)
  }

  function drop(change: ConfigChange) {
    setStaged((s) => s.filter((c) => c !== change))
    setRefusal(null)
  }

  function clear() {
    setStaged([])
    setRefusal(null)
  }

  /** Opens one candidate, applies every change and opens the review; a refused line closes it. */
  async function review() {
    setPreparing(true)
    setRefusal(null)
    try {
      const c = await api.post<OpenCandidateResponse>(routerApi(routerId, "/config/candidates"), {})
      for (const change of staged) {
        try {
          await api.post(routerApi(routerId, `/config/candidates/${c.candidate_id}/edit`), { path: change.path, lines: change.lines })
        } catch (err) {
          setRefusal({ message: errorMessage(err), items: err instanceof ApiError ? (err.diagnostics?.items ?? []) : [], change })
          await discardCandidate(routerId, c.candidate_id)
          return
        }
      }
      setReviewing(c.candidate_id)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setPreparing(false)
    }
  }

  return {
    staged,
    stage,
    drop,
    clear,
    review,
    preparing,
    refusal,
    /** The candidate under review, for ChangeReview. */
    reviewing,
    closeReview: () => setReviewing(null),
  }
}

export type ConfigChanges = ReturnType<typeof useConfigChanges>
