"use client"

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

/** A card of live state: a skeleton while read, "Nothing configured." when empty. */
export function Section({
  title,
  description,
  loading,
  empty,
  action,
  children,
}: {
  title: string
  description?: string
  loading: boolean
  empty?: boolean
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card className="py-0">
      <CardHeader className="pt-6">
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      {loading ? (
        <CardContent className="pb-6">
          <Skeleton className="h-16 w-full" />
        </CardContent>
      ) : empty ? (
        <CardContent className="text-muted-foreground pb-6 text-sm">Nothing configured.</CardContent>
      ) : (
        <div className="overflow-x-auto pb-2">{children}</div>
      )}
    </Card>
  )
}
