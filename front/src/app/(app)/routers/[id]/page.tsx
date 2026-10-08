"use client"

import { useParams } from "next/navigation"

import { TrafficChart } from "@/components/traffic-chart"
import { ActivityWidget } from "@/components/widgets/activity-widget"
import { BgpWidget } from "@/components/widgets/bgp-widget"
import { BoxLogWidget } from "@/components/widgets/box-log-widget"
import { CgnatWidget } from "@/components/widgets/cgnat-widget"
import { InterfacesWidget } from "@/components/widgets/interfaces-widget"
import { LoadWidget } from "@/components/widgets/load-widget"
import { PlaneResourcesWidget } from "@/components/widgets/plane-resources-widget"
import { RouterStatsWidget } from "@/components/widgets/router-stats-widget"
import { UptimeWidget } from "@/components/widgets/uptime-widget"

export default function RouterOverviewPage() {
  const { id } = useParams<{ id: string }>()
  return (
    <>
      <RouterStatsWidget routerId={id} />
      <TrafficChart routerId={id} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <UptimeWidget routerId={id} />
        <BgpWidget routerId={id} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <CgnatWidget routerId={id} />
        <LoadWidget routerId={id} />
      </div>
      {/* CPUs and RAM by plane (#81). */}
      <PlaneResourcesWidget routerId={id} />
      {/* Prisma 0.151.14 (#75): `show log`; nothing on a box before it. */}
      <BoxLogWidget routerId={id} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
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
