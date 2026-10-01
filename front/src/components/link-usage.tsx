import type { InterfaceRate } from "@/hooks/use-interface-rates"
import { formatLinkSpeed, formatPercent, knownSpeed, linkUtilization } from "@/lib/format"
import type { RouterInterface } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Link speed and utilization (#25): the busier direction over the speed. With
 * an unknown speed (0, or VPP's 4294967295000) it says so and shows no
 * percentage; with no live rate it shows the speed alone.
 */
export function LinkUsage({ iface, rate, className }: { iface: RouterInterface; rate?: InterfaceRate; className?: string }) {
  const speed = knownSpeed(iface.speed_bps)
  if (speed === null) {
    return (
      <div className={cn("text-muted-foreground text-xs", className)} title="The dataplane does not report a speed for this link">
        speed unknown
      </div>
    )
  }
  const pct = rate && iface.link_up ? linkUtilization(rate.rx_bps, rate.tx_bps, speed) : null
  return (
    <div className={cn("min-w-24 space-y-1", className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
        <span className="font-medium">{formatLinkSpeed(speed)}</span>
        {pct !== null && (
          <span className="text-muted-foreground" title="Busier direction (received or sent) over the link speed">
            {formatPercent(pct)}
          </span>
        )}
      </div>
      {pct !== null && (
        <div className="bg-muted h-1.5 overflow-hidden rounded-full" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`${iface.name} utilization`}>
          <div
            className={cn("h-full rounded-full transition-all duration-500", pct > 85 ? "bg-destructive" : pct > 65 ? "bg-chart-4" : "bg-primary")}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      )}
    </div>
  )
}
