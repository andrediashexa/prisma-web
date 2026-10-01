import { Badge } from "@/components/ui/badge"
import type { RouterInterface } from "@/lib/types"

/** Estado da interface: desligada (shutdown), sem link ou com link. */
export function LinkBadge({ iface }: { iface: Pick<RouterInterface, "admin_up" | "link_up"> }) {
  if (!iface.admin_up) return <Badge variant="outline">desligada</Badge>
  if (!iface.link_up) return <Badge variant="destructive">sem link</Badge>
  return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">link ok</Badge>
}
