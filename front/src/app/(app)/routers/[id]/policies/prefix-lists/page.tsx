"use client"

import { FrrPrefixListsCard, ListsNotReported } from "@/components/policies/frr-lists"
import { ListsCard } from "@/components/policies/lists-card"

export default function PrefixListsPage() {
  return (
    <>
      <ListsNotReported />
      <ListsCard kind="prefix-list" title="Prefix-lists" description="policy-options' prefix-lists: the networks a policy term matches with from prefix-list" />
      <FrrPrefixListsCard />
    </>
  )
}
