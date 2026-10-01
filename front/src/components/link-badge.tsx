import { Badge } from "@/components/ui/badge"
import type { RouterInterface } from "@/lib/types"

/** Interface state: disabled (shutdown), no link or link up. */
export function LinkBadge({ iface }: { iface: Pick<RouterInterface, "admin_up" | "link_up"> }) {
  if (!iface.admin_up) return <Badge variant="outline">shut down</Badge>
  if (!iface.link_up) return <Badge variant="destructive">no link</Badge>
  return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">link ok</Badge>
}
