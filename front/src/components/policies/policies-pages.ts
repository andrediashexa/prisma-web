/** The policy pages under /routers/{id}/policies (#89), in the sidebar's and the page's order. */
export const POLICY_PAGES = [
  { href: "", label: "Policy" },
  { href: "/prefix-lists", label: "Prefix-list" },
  { href: "/communities", label: "BGP community" },
] as const
