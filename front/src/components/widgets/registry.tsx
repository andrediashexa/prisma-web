"use client"

import { ActivityIcon, BarChart3Icon, GaugeIcon, NetworkIcon, ServerIcon, TrendingUpIcon, UnplugIcon } from "lucide-react"

import { TrafficChart } from "@/components/traffic-chart"
import { Card, CardContent } from "@/components/ui/card"
import type { RouterView } from "@/lib/types"

import { ActivityWidget } from "./activity-widget"
import { FleetWidget } from "./fleet-widget"
import { InterfacesWidget } from "./interfaces-widget"
import { ResourcesWidget } from "./resources-widget"
import { RouterStatsWidget } from "./router-stats-widget"
import type { DashboardLayout, Widget, WidgetConfig, WidgetSize, WidgetType } from "./types"

interface WidgetDef {
  title: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  defaultSize: WidgetSize
  /** O widget mostra dados de um roteador específico. */
  perRouter: boolean
  /** Aceita escolher interface e período (gráfico de tráfego). */
  traffic?: boolean
  /** Filtro opcional por roteador (atividade). */
  optionalRouter?: boolean
}

export const WIDGETS: Record<WidgetType, WidgetDef> = {
  fleet: {
    title: "Roteadores",
    description: "Estado de todos os Prismas cadastrados",
    icon: ServerIcon,
    defaultSize: 4,
    perRouter: false,
  },
  resources: {
    title: "Recursos por roteador",
    description: "Gráfico comparando CPU e memória entre os Prismas",
    icon: BarChart3Icon,
    defaultSize: 2,
    perRouter: false,
  },
  "router-stats": {
    title: "Indicadores",
    description: "Tempo ligado, CPU, memória e interfaces de um Prisma",
    icon: GaugeIcon,
    defaultSize: 4,
    perRouter: true,
  },
  traffic: {
    title: "Tráfego",
    description: "Gráfico de download e upload de uma interface",
    icon: TrendingUpIcon,
    defaultSize: 4,
    perRouter: true,
    traffic: true,
  },
  interfaces: {
    title: "Interfaces",
    description: "Lista de interfaces com endereços IPv4 e IPv6",
    icon: NetworkIcon,
    defaultSize: 2,
    perRouter: true,
  },
  activity: {
    title: "Atividade recente",
    description: "Últimos eventos do log de mudanças",
    icon: ActivityIcon,
    defaultSize: 2,
    perRouter: false,
    optionalRouter: true,
  },
}

export const SIZE_LABEL: Record<WidgetSize, string> = {
  1: "Estreito (1/4)",
  2: "Médio (1/2)",
  3: "Largo (3/4)",
  4: "Linha inteira",
}

/** Classes de coluna para uma grade 1 → 2 → 4 colunas. */
export const SIZE_CLASS: Record<WidgetSize, string> = {
  1: "",
  2: "md:col-span-2",
  3: "md:col-span-2 xl:col-span-3",
  4: "md:col-span-2 xl:col-span-4",
}

// crypto.randomUUID só existe em contexto seguro (HTTPS/localhost); a interface roda em HTTP.
const widgetId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

export function newWidget(type: WidgetType, config: WidgetConfig = {}): Widget {
  return { id: widgetId(), type, size: WIDGETS[type].defaultSize, config }
}

/** Homepage inicial de quem ainda não personalizou. */
export function defaultLayout(routers: RouterView[]): DashboardLayout {
  const first = routers[0]?.id
  const widgets: Widget[] = [newWidget("fleet")]
  if (first) {
    widgets.push(
      newWidget("router-stats", { routerId: first }),
      newWidget("traffic", { routerId: first, minutes: 60 }),
      newWidget("interfaces", { routerId: first }),
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
  if (!def) return <Missing text={`Widget desconhecido: ${widget.type}`} />

  const routerId = widget.config.routerId
  const router = routerId ? routers?.find((r) => r.id === routerId) : undefined
  if (def.perRouter && routers && !router) {
    return <Missing text="O roteador deste widget foi removido ou não está configurado. Edite a página para escolher outro." />
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
          title={router ? `Tráfego · ${router.name}` : "Tráfego"}
          defaultInterface={widget.config.interface}
          defaultMinutes={widget.config.minutes}
        />
      ) : null
    case "interfaces":
      return routerId ? <InterfacesWidget routerId={routerId} title={router ? `Interfaces · ${router.name}` : undefined} /> : null
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
