import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  percent,
  loading,
}: {
  label: string
  value?: React.ReactNode
  hint?: React.ReactNode
  icon: React.ComponentType<{ className?: string }>
  /** Shows a usage bar (0–100). */
  percent?: number
  loading?: boolean
}) {
  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardDescription>{label}</CardDescription>
        <span className="bg-primary/10 text-primary flex size-8 items-center justify-center rounded-lg">
          <Icon className="size-4" />
        </span>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <CardTitle className="text-2xl font-semibold tabular-nums">{value}</CardTitle>
        )}
        {percent !== undefined && !loading && (
          <div className="bg-muted h-1.5 overflow-hidden rounded-full">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                percent > 85 ? "bg-destructive" : percent > 65 ? "bg-chart-4" : "bg-primary",
              )}
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          </div>
        )}
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </CardContent>
    </Card>
  )
}
