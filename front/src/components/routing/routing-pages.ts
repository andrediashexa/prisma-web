/** The routing pages under /routers/{id}/routing (#88), in the sidebar's and the page's order. */
export const ROUTING_PAGES = [
  { href: "", label: "Routing table" },
  { href: "/static", label: "Static" },
  { href: "/bgp", label: "BGP" },
  { href: "/ospf", label: "OSPF" },
  { href: "/isis", label: "IS-IS" },
  { href: "/bfd", label: "BFD" },
  { href: "/vrrp", label: "VRRP" },
  { href: "/logging", label: "Logging" },
] as const
