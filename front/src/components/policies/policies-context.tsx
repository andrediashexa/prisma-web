"use client"

import { createContext, useContext, useState } from "react"
import useSWR from "swr"

import { ChangeReview } from "@/components/config/change-review"
import { StagedChanges } from "@/components/config/staged-changes"
import { useConfigChanges } from "@/hooks/use-config-changes"
import { useRouterAccess, useRouterRole } from "@/hooks/use-routers"
import { fetcher } from "@/lib/api"
import { boxAllows, type Grammar } from "@/lib/config-model"
import { setMembers, type FrrLists, type ListKind, type PolicyLists } from "@/lib/policy-lists"
import { useTypedConfig } from "@/lib/typed-config"
import { roleAtLeast, routerApi, type Policy } from "@/lib/types"

interface PoliciesState {
  routerId: string
  /** undefined while read; null on a box before 0.149.24, which does not type the lists. */
  lists: PolicyLists | null | undefined
  frr: FrrLists | null | undefined
  policies: Policy[]
  editable: boolean
  /** A list's members as staged, else as running; null when it does not exist. */
  membersOf: (kind: ListKind, name: string) => string[] | null
  /** A list's members as running; null when it does not run. */
  runningOf: (kind: ListKind, name: string) => string[] | null
  /** The lists of a kind: running ones, then new ones staged. */
  namesOf: (kind: ListKind) => string[]
  /** Whether a change to the list is staged. */
  isStaged: (kind: ListKind, name: string) => boolean
  /** Stages `members` as the list's members ([] removes it). */
  stageMembers: (kind: ListKind, name: string, members: string[], label: string) => void
}

const PoliciesContext = createContext<PoliciesState | null>(null)

export function usePolicies() {
  const v = useContext(PoliciesContext)
  if (!v) throw new Error("usePolicies outside the policy pages")
  return v
}

const RUNNING: Record<ListKind, keyof Pick<PolicyLists, "prefix_lists" | "communities" | "large_communities" | "extended_communities">> = {
  "prefix-list": "prefix_lists",
  community: "communities",
  "large-community": "large_communities",
  "extended-community": "extended_communities",
}

/**
 * What the policy pages share (#89): the lists read once, and one set of staged changes with its
 * review, so lists changed on Prefix-list and BGP community are applied together.
 */
export function PoliciesProvider({ routerId: id, children }: { routerId: string; children: React.ReactNode }) {
  const typed = useTypedConfig(id, ["policy", "frr_lists"])
  const { data: pol, mutate: mutatePolicies } = useSWR<{ policies: Policy[] }>(routerApi(id, "/policies"), fetcher)
  const { data: grammar } = useSWR<Grammar>(routerApi(id, "/config/grammar"), fetcher, { revalidateOnFocus: false })
  const cc = useConfigChanges(id)
  const myRole = useRouterRole(id)
  const { access, readOnly } = useRouterAccess(id)
  // policy-options is written by the box's administrators (the grammar's roles).
  const roles = grammar?.modes.find((m) => m.key === "policy-options")?.roles ?? ["administrator"]
  const lists = typed.typed === false ? null : typed.config ? (typed.config.policy ?? null) : undefined
  const editable = !!lists && roleAtLeast(myRole, "operator") && !readOnly && boxAllows(access, { roles })
  // The members a staged change gives a list, while that change is staged.
  const [drafts, setDrafts] = useState<Record<string, string[]>>({})
  const staged = new Set(cc.changes.map((c) => c.key))

  const running = (kind: ListKind, name: string) => lists?.[RUNNING[kind]].find((l) => l.name === name)?.members ?? null
  const membersOf = (kind: ListKind, name: string) => {
    const key = `${kind} ${name}`
    if (staged.has(key) && drafts[key]) return drafts[key].length ? drafts[key] : null
    return running(kind, name)
  }
  const stageMembers = (kind: ListKind, name: string, members: string[], label: string) => {
    const key = `${kind} ${name}`
    const before = running(kind, name)
    // Back to what runs: nothing to stage.
    const same = before ? before.length === members.length && before.every((m, i) => m === members[i]) : members.length === 0
    if (same) {
      const n = cc.changes.findIndex((x) => x.key === key)
      if (n >= 0) cc.unstage(n)
      return
    }
    setDrafts((d) => ({ ...d, [key]: members }))
    cc.stage({ ...setMembers(kind, name, before, members), label, key })
  }

  const value: PoliciesState = {
    routerId: id,
    lists,
    frr: typed.typed === false ? null : typed.config ? (typed.config.frr_lists ?? null) : undefined,
    policies: pol?.policies ?? [],
    editable,
    membersOf,
    runningOf: running,
    namesOf: (kind) => {
      const names = (lists?.[RUNNING[kind]] ?? []).map((l) => l.name)
      for (const k of Object.keys(drafts)) {
        const name = k.slice(kind.length + 1)
        if (k.startsWith(kind + " ") && staged.has(k) && !names.includes(name)) names.push(name)
      }
      return names
    },
    isStaged: (kind, name) => staged.has(`${kind} ${name}`),
    stageMembers,
  }

  return (
    <PoliciesContext.Provider value={value}>
      {typed.error && <p className="text-destructive text-sm">Could not read the typed configuration: {typed.error.message}</p>}
      {children}
      <div className="sticky bottom-4 z-20 shadow-lg empty:hidden">
        <StagedChanges cc={cc} />
      </div>
      <ChangeReview
        routerId={id}
        candidateId={cc.candidateId}
        title="Apply policy changes"
        defaultComment={cc.reviewed.map((c) => c.label).join("; ")}
        onClose={cc.closeReview}
        onStale={cc.reopen}
        staged={cc.staged}
        onCommitted={() => {
          cc.committed()
          setDrafts({})
          void typed.mutate()
          void mutatePolicies()
        }}
      />
    </PoliciesContext.Provider>
  )
}
