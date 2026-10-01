import { Badge } from "@/components/ui/badge"
import { isIpv6, isLinkLocal } from "@/lib/format"

/** Address list with IPv6 highlighted and link-local dimmed. */
export function AddressList({ addresses, hideLinkLocal }: { addresses: string[]; hideLinkLocal?: boolean }) {
  const list = hideLinkLocal ? addresses.filter((a) => !isLinkLocal(a)) : addresses
  if (list.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-col gap-1">
      {list.map((a) => (
        <div key={a} className="flex items-center gap-1.5">
          <Badge
            variant="outline"
            className={isIpv6(a) ? "border-chart-2/40 text-chart-2 px-1 font-mono text-[10px]" : "px-1 font-mono text-[10px]"}
          >
            {isIpv6(a) ? "v6" : "v4"}
          </Badge>
          <span className={`font-mono text-xs ${isLinkLocal(a) ? "text-muted-foreground" : ""}`}>{a}</span>
        </div>
      ))}
    </div>
  )
}
