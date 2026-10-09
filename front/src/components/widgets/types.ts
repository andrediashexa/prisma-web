export type WidgetType = "fleet" | "router-stats" | "traffic" | "interfaces" | "activity" | "resources" | "cgnat" | "bgp" | "uptime" | "load" | "cpu-planes"

/** Width in columns of a 4-column grid. */
export type WidgetSize = 1 | 2 | 3 | 4

export interface WidgetConfig {
  routerId?: string
  interface?: string
  minutes?: number
  /** "cpu-planes" (#85): bars, map, donut or table. */
  view?: string
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
