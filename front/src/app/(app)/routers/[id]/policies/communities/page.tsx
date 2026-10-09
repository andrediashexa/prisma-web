"use client"

import { FrrCommunityListsCard, ListsNotReported } from "@/components/policies/frr-lists"
import { ListsCard } from "@/components/policies/lists-card"

export default function CommunitiesPage() {
  return (
    <>
      <ListsNotReported />
      <ListsCard kind="community" title="Communities" description="Standard BGP communities, asn:value; a policy matches on them with from community, or adds them with set community" />
      <ListsCard kind="large-community" title="Large communities" description="RFC 8092 communities, asn:value1:value2" />
      <ListsCard kind="extended-community" title="Extended communities" description="Route targets and sites of origin, rt: or soo: then asn:value" />
      <FrrCommunityListsCard />
    </>
  )
}
