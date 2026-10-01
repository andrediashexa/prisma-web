"use client"

import { useParams } from "next/navigation"

import { TrafficChart } from "@/components/traffic-chart"
import { ActivityWidget } from "@/components/widgets/activity-widget"
import { BgpWidget } from "@/components/widgets/bgp-widget"
import { CgnatWidget } from "@/components/widgets/cgnat-widget"
import { InterfacesWidget } from "@/components/widgets/interfaces-widget"
import { RouterStatsWidget } from "@/components/widgets/router-stats-widget"
import { UptimeWidget } from "@/components/widgets/uptime-widget"

export default function RouterOverviewPage() {
  const { id } = useParams<{ id: string }>()
  return (
    <>
      <RouterStatsWidget routerId={id} />
      <TrafficChart routerId={id} />
      <div className="grid gap-4 xl:grid-cols-2">
        <UptimeWidget routerId={id} />
        <BgpWidget routerId={id} />
      </div>
      <div>
        <CgnatWidget routerId={id} />
      </div>
      <div className="grid gap-4 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <InterfacesWidget routerId={id} />
        </div>
        <div className="xl:col-span-2">
          <ActivityWidget routerId={id} />
        </div>
      </div>
    </>
  )
}
