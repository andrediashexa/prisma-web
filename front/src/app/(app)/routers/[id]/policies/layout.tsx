"use client"

import { useParams } from "next/navigation"

import { PoliciesProvider } from "@/components/policies/policies-context"
import { POLICY_PAGES } from "@/components/policies/policies-pages"
import { SubNav } from "@/components/sub-nav"

/** The policy pages (#89): the policies, and the prefix-lists and communities they match on. */
export default function PoliciesLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>()
  return (
    <PoliciesProvider routerId={id}>
      <SubNav label="Policies" base={`/routers/${id}/policies`} pages={POLICY_PAGES} />
      {children}
    </PoliciesProvider>
  )
}
