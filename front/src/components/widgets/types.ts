export type WidgetType = "fleet" | "router-stats" | "traffic" | "interfaces" | "activity" | "resources"

/** Largura em colunas de uma grade de 4. */
export type WidgetSize = 1 | 2 | 3 | 4

export interface WidgetConfig {
  routerId?: string
  interface?: string
  minutes?: number
}

export interface Widget {
  id: string
  type: WidgetType
  size: WidgetSize
  config: WidgetConfig
}

export interface DashboardLayout {
  version: 1
  widgets: Widget[]
}
