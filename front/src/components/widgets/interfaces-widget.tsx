"use client"

import Link from "next/link"
import useSWR from "swr"
import { ArrowRightIcon } from "lucide-react"

import { AddressList } from "@/components/address-list"
import { InterfaceIcon } from "@/components/interface-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher } from "@/lib/api"
import { routerApi, type RouterInterface } from "@/lib/types"

export function InterfacesWidget({ routerId, title = "Interfaces" }: { routerId: string; title?: string }) {
  const { data } = useSWR<RouterInterface[]>(routerApi(routerId, "/interfaces"), fetcher, { refreshInterval: 10_000 })
  const physical = data?.filter((i) => i.kind !== "loopback") ?? []

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>Estado e endereçamento dual-stack</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/routers/${routerId}/interfaces`}>
              Gerenciar <ArrowRightIcon />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="divide-y">
        {!data && <Skeleton className="h-40 w-full" />}
        {physical.map((i) => (
          <div key={i.name} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
            <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
              <InterfaceIcon kind={i.kind} className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium">{i.name}</span>
                <span className="text-muted-foreground truncate text-xs">{i.description}</span>
              </div>
              <div className="mt-1">
                <AddressList addresses={i.addresses} hideLinkLocal />
              </div>
            </div>
            <Badge
              variant={i.oper_state === "up" ? "default" : "outline"}
              className={i.oper_state === "up" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : ""}
            >
              {i.oper_state === "up" ? "ativa" : "inativa"}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
