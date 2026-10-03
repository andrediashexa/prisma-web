"use client"

import { useState } from "react"
import { toast } from "sonner"

import { api, ApiError, errorMessage } from "@/lib/api"
import { routerApi, type Diagnostic, type OpenCandidateResponse } from "@/lib/types"

/** A change waiting for review: lines at a path, applied as one Edit. */
export interface StagedEdit {
  path: string[]
  lines: string[]
  /** What it does, for the list; the lines when absent. */
  label?: string
}

/** The VTY refused a staged edit: its message, diagnostics and which edit. */
export interface Refusal {
  message: string
  items: Diagnostic[]
  edit: StagedEdit
}

/**
 * Changes staged by the configuration forms (#39, #42): nothing reaches the
 * router until `review()` opens one candidate, applies every edit in order
 * and hands the candidate to ChangeReview (`reviewing`). A refused edit
 * closes the candidate and is reported in `refusal`.
 */
export function useConfigChanges(routerId: string) {
  const [staged, setStaged] = useState<StagedEdit[]>([])
  const [preparing, setPreparing] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [reviewing, setReviewing] = useState<string | null>(null)

  /** Adds edits, in order; empty ones are left out. */
  function stage(...edits: StagedEdit[]) {
    const real = edits.filter((e) => e.lines.length > 0)
    if (real.length === 0) return
    setStaged((s) => [...s, ...real])
    setRefusal(null)
  }

  function drop(index: number) {
    setStaged((s) => s.filter((_, i) => i !== index))
    setRefusal(null)
  }

  function clear() {
    setStaged([])
    setRefusal(null)
  }

  async function review() {
    setPreparing(true)
    setRefusal(null)
    try {
      const c = await api.post<OpenCandidateResponse>(routerApi(routerId, "/config/candidates"), {})
      const cid = c.candidate_id
      for (const e of staged) {
        try {
          await api.post(routerApi(routerId, `/config/candidates/${cid}/edit`), { path: e.path, lines: e.lines })
        } catch (err) {
          setRefusal({ message: errorMessage(err), items: err instanceof ApiError ? (err.diagnostics?.items ?? []) : [], edit: e })
          await api.delete(routerApi(routerId, `/config/candidates/${cid}`)).catch(() => undefined)
          return
        }
      }
      setReviewing(cid)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setPreparing(false)
    }
  }

  return { staged, stage, drop, clear, review, preparing, refusal, reviewing, closeReview: () => setReviewing(null) }
}

export type ConfigChanges = ReturnType<typeof useConfigChanges>
