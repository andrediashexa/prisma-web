"use client"

import { ActivityIcon, BarChart3Icon, CpuIcon, GaugeIcon, NetworkIcon, ServerIcon, ShareIcon, TrendingUpIcon, TimerIcon, UnplugIcon, UsersIcon } from "lucide-react"

import { TrafficChart } from "@/components/traffic-chart"
import { Card, CardContent } from "@/components/ui/card"
import type { RouterView } from "@/lib/types"

import { ActivityWidget } from "./activity-widget"
import { BgpWidget } from "./bgp-widget"
import { CgnatWidget } from "./cgnat-widget"
import { FleetWidget } from "./fleet-widget"
import { InterfacesWidget } from "./interfaces-widget"
import { LoadWidget } from "./load-widget"
import { PlaneResourcesWidget } from "./plane-resources-widget"
import { ResourcesWidget } from "./resources-widget"
import { RouterStatsWidget } from "./router-stats-widget"
import { UptimeWidget } from "./uptime-widget"
import { isResourceView } from "@/lib/resources"

import type { DashboardLayout, Widget, WidgetConfig, WidgetSize, WidgetType } from "./types"

interface WidgetDef {
  title: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  defaultSize: WidgetSize
  /** The widget shows data from a specific router. */
  perRouter: boolean
  /** Lets the user pick an interface and time range (traffic chart). */
  traffic?: boolean
  /** Optional filter by router (activity). */
  optionalRouter?: boolean
  /** Lets the user pick how it is shown (#85). */
  views?: boolean
}

export const WIDGETS: Record<WidgetType, WidgetDef> = {
  fleet: {
    title: "Routers",
    description: "State of every registered router",
    icon: ServerIcon,
    defaultSize: 4,
    perRouter: false,
  },
  resources: {
    title: "Sessions per router",
    description: "Chart comparing session table usage across routers",
    icon: BarChart3Icon,
    defaultSize: 2,
    perRouter: false,
  },
  "router-stats": {
    title: "Key metrics",
    description: "Uptime, dataplane, sessions and interfaces of a router",
    icon: GaugeIcon,
    defaultSize: 4,
    perRouter: true,
  },
  traffic: {
    title: "Traffic",
    description: "Download and upload chart for an interface",
    icon: TrendingUpIcon,
    defaultSize: 4,
    perRouter: true,
    traffic: true,
  },
  interfaces: {
    title: "Interfaces",
    description: "Interface list with link usage and IPv4 and IPv6 addresses",
    icon: NetworkIcon,
    defaultSize: 2,
    perRouter: true,
  },
  cgnat: {
    title: "CGNAT",
    description: "Chart of sessions and subscribers over time",
    icon: UsersIcon,
    defaultSize: 2,
    perRouter: true,
  },
  bgp: {
    title: "BGP neighbors",
    description: "State of a router's BGP sessions",
    icon: ShareIcon,
    defaultSize: 2,
    perRouter: true,
  },
  uptime: {
    title: "Uptime",
    description: "Since when each part of a Prisma runs, with a dataplane-restart warning",
    icon: TimerIcon,
    defaultSize: 2,
    perRouter: true,
  },
  load: {
    title: "Dataplane load",
    description: "Memory used and each dataplane worker's load",
    icon: CpuIcon,
    defaultSize: 2,
    perRouter: true,
  },
  "cpu-planes": {
    title: "CPUs and RAM by plane",
    description: "How a router's cores and memory are split among its planes: bars, a CPU map, donuts or a table",
    icon: CpuIcon,
    defaultSize: 2,
    perRouter: true,
    views: true,
  },
  activity: {
    title: "Recent activity",
    description: "Latest events from the change log",
    icon: ActivityIcon,
    defaultSize: 2,
    perRouter: false,
    optionalRouter: true,
  },
}

export const SIZE_LABEL: Record<WidgetSize, string> = {
  1: "Narrow (1/4)",
  2: "Medium (1/2)",
  3: "Wide (3/4)",
  4: "Full row",
}

/** Column classes for a 1 → 2 → 4 column grid. */
export const SIZE_CLASS: Record<WidgetSize, string> = {
  1: "",
  2: "md:col-span-2",
  3: "md:col-span-2 xl:col-span-3",
  4: "md:col-span-2 xl:col-span-4",
}

// crypto.randomUUID only exists in a secure context (HTTPS/localhost); the UI runs over HTTP.
const widgetId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

export function newWidget(type: WidgetType, config: WidgetConfig = {}): Widget {
  return { id: widgetId(), type, size: WIDGETS[type].defaultSize, config }
}

/** Default home page for users who have not customized theirs yet. */
export function defaultLayout(routers: RouterView[]): DashboardLayout {
  const first = routers[0]?.id
  const widgets: Widget[] = [newWidget("fleet")]
  if (first) {
    widgets.push(
      newWidget("router-stats", { routerId: first }),
      newWidget("traffic", { routerId: first, minutes: 60 }),
      newWidget("cgnat", { routerId: first }),
      newWidget("load", { routerId: first }),
      newWidget("bgp", { routerId: first }),
    )
  }
  widgets.push(routers.length > 1 ? newWidget("resources") : newWidget("activity"))
  if (routers.length > 1) widgets.push(newWidget("activity"))
  return { version: 1, widgets }
}

export function widgetTitle(w: Widget, routers: RouterView[] | undefined) {
  const base = WIDGETS[w.type]?.title ?? w.type
  const router = w.config.routerId && routers?.find((r) => r.id === w.config.routerId)
  return router ? `${base} · ${router.name}` : base
}

export function WidgetView({ widget, routers }: { widget: Widget; routers: RouterView[] | undefined }) {
  const def = WIDGETS[widget.type]
  if (!def) return <Missing text={`Unknown widget: ${widget.type}`} />

  const routerId = widget.config.routerId
  const router = routerId ? routers?.find((r) => r.id === routerId) : undefined
  if (def.perRouter && routers && !router) {
    return <Missing text="This widget's router was removed or is not configured. Edit the page to pick another one." />
  }

  switch (widget.type) {
    case "fleet":
      return <FleetWidget />
    case "resources":
      return <ResourcesWidget />
    case "router-stats":
      return routerId ? <RouterStatsWidget routerId={routerId} /> : null
    case "traffic":
      return routerId ? (
        <TrafficChart
          key={`${routerId}-${widget.config.interface}-${widget.config.minutes}`}
          routerId={routerId}
          title={router ? `Traffic · ${router.name}` : "Traffic"}
          defaultInterface={widget.config.interface}
          defaultMinutes={widget.config.minutes}
        />
      ) : null
    case "interfaces":
      return routerId ? <InterfacesWidget routerId={routerId} title={router ? `Interfaces · ${router.name}` : undefined} /> : null
    case "cgnat":
      return routerId ? <CgnatWidget routerId={routerId} title={router ? `CGNAT · ${router.name}` : undefined} /> : null
    case "bgp":
      return routerId ? <BgpWidget routerId={routerId} title={router ? `BGP · ${router.name}` : undefined} /> : null
    case "uptime":
      return routerId ? <UptimeWidget routerId={routerId} title={router ? `Uptime · ${router.name}` : undefined} /> : null
    case "cpu-planes":
      return routerId ? (
        <PlaneResourcesWidget
          key={`${routerId}-${widget.config.view}`}
          routerId={routerId}
          title={router ? `CPUs and RAM · ${router.name}` : undefined}
          view={isResourceView(widget.config.view) ? widget.config.view : "bars"}
        />
      ) : null
    case "load":
      return routerId ? <LoadWidget routerId={routerId} title={router ? `Dataplane load · ${router.name}` : undefined} /> : null
    case "activity":
      return <ActivityWidget routerId={router?.id} />
  }
}

function Missing({ text }: { text: string }) {
  return (
    <Card className="h-full border-dashed">
      <CardContent className="text-muted-foreground flex h-full min-h-32 items-center justify-center gap-2 text-center text-sm">
        <UnplugIcon className="size-4 shrink-0" />
        {text}
      </CardContent>
    </Card>
  )
}
