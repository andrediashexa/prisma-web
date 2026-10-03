"use client"

import { useState } from "react"
import { toast } from "sonner"

import { api, ApiError, errorMessage } from "@/lib/api"
import type { SetConfigResponse, TypedEdit } from "@/lib/typed-config"
import { routerApi, type Diagnostic, type OpenCandidateResponse } from "@/lib/types"

/** A change waiting for review: lines at a path, as one Edit, and/or typed edits (#46). */
export interface ConfigChange {
  path: string[]
  lines: string[]
  /**
   * SetConfig / DeleteConfig calls (Prisma 0.149.20+), made against the
   * candidate after `lines` when the changes are reviewed; the box answers
   * the lines it staged for them, kept in `staged` as the preview.
   */
  typed?: TypedEdit[]
  /** What the typed edits set, for the list (`mtu 9000`); a password is never in it. */
  summary?: string[]
  /** What it does, for the list. */
  label: string
  /** Staging again with the same key replaces the change (a form edited twice). */
  key?: string
  /** What the user should know before the review (a remap the gates will ask about), shown with the change (#41). */
  warning?: string
}

/** The lines the box staged for a change's typed edits, where it staged them. */
export interface StagedLines {
  change: ConfigChange
  path: string[]
  lines: string[]
}

/** Whether a change carries anything to apply. */
export const hasEdits = (c: ConfigChange) => c.lines.length > 0 || (c.typed?.length ?? 0) > 0

/** The VTY refused a line while the changes were applied to the candidate. */
export interface ChangeRefusal {
  message: string
  items: Diagnostic[]
  change: ConfigChange
}

/**
 * Changes staged on a screen, applied together to one candidate and then
 * handed to ChangeReview (#39, #40). Nothing reaches the router before the
 * review: a refused line closes the candidate and says which change it was.
 */
export function useConfigChanges(routerId: string) {
  const [changes, setChanges] = useState<ConfigChange[]>([])
  const [preparing, setPreparing] = useState(false)
  const [refusal, setRefusal] = useState<ChangeRefusal | null>(null)
  const [candidateId, setCandidateId] = useState<string | null>(null)
  // What the open candidate holds, to reopen it (#10) and to know what a commit took.
  const [reviewed, setReviewed] = useState<ConfigChange[]>([])
  // What the box staged for the typed edits of the open candidate (#46).
  const [staged, setStaged] = useState<StagedLines[]>([])

  function stage(c: ConfigChange) {
    setRefusal(null)
    setChanges((all) => {
      const rest = c.key ? all.filter((x) => x.key !== c.key) : all
      if (!hasEdits(c)) return rest
      const at = c.key ? all.findIndex((x) => x.key === c.key) : -1
      return at < 0 ? [...rest, c] : [...rest.slice(0, at), c, ...rest.slice(at)]
    })
  }

  function unstage(n: number) {
    setChanges((all) => all.filter((_, i) => i !== n))
    setRefusal(null)
  }

  function clear() {
    setChanges([])
    setRefusal(null)
  }

  /** Opens a candidate with `list` (the staged changes by default) and opens the review. */
  async function review(list: ConfigChange[] = changes) {
    setPreparing(true)
    setRefusal(null)
    try {
      const c = await api.post<OpenCandidateResponse>(routerApi(routerId, "/config/candidates"), {})
      const boxLines: StagedLines[] = []
      for (const e of list) {
        if (!hasEdits(e)) continue
        try {
          if (e.lines.length > 0) await api.post(routerApi(routerId, `/config/candidates/${c.candidate_id}/edit`), { path: e.path, lines: e.lines })
          // Typed edits are SetConfig / DeleteConfig against this candidate: the box writes the lines.
          for (const t of e.typed ?? []) {
            const r =
              "set" in t
                ? await api.post<SetConfigResponse>(routerApi(routerId, `/config/typed/${c.candidate_id}/set`), { ...t.set, fields: t.fields })
                : await api.post<SetConfigResponse>(routerApi(routerId, `/config/typed/${c.candidate_id}/delete`), t.remove)
            boxLines.push({ change: e, path: r.path, lines: r.lines })
          }
        } catch (err) {
          setRefusal({ message: errorMessage(err), items: err instanceof ApiError ? (err.diagnostics?.items ?? []) : [], change: e })
          await api.delete(routerApi(routerId, `/config/candidates/${c.candidate_id}`)).catch(() => undefined)
          return false
        }
      }
      setReviewed(list)
      setStaged(boxLines)
      setCandidateId(c.candidate_id)
      return true
    } catch (err) {
      toast.error(errorMessage(err))
      return false
    } finally {
      setPreparing(false)
    }
  }

  /** The running configuration moved: the same changes on a new candidate (#10). */
  async function reopen() {
    const old = candidateId
    setCandidateId(null)
    if (old) await api.delete(routerApi(routerId, `/config/candidates/${old}`)).catch(() => undefined)
    await review(reviewed)
  }

  /** After a commit: what it carried is no longer staged. */
  function committed() {
    setChanges((all) => all.filter((c) => !reviewed.includes(c)))
    setReviewed([])
  }

  return {
    changes,
    stage,
    unstage,
    clear,
    review,
    reopen,
    committed,
    preparing,
    refusal,
    candidateId,
    /** What the open candidate holds. */
    reviewed,
    /** The lines the box staged for the typed edits of the open candidate: the preview (#46). */
    staged,
    closeReview: () => setCandidateId(null),
  }
}
