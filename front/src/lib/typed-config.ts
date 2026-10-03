/**
 * The configuration as fields (Prisma 0.149.20 and 0.149.22, #46): the
 * shapes GetConfig answers and SetConfig / DeleteConfig take, as the back end
 * serves them (`/config/typed`, `/config/typed/{cid}/set|delete`).
 *
 * A form's data layer (interface-config.ts, cgnat-config.ts,
 * routing-config.ts) uses these when the box answers GetConfig for its area,
 * and its line implementation otherwise. Two rules of the contract hold here:
 * a SetConfig always names its fields (an empty mask would set every field,
 * clearing what the object leaves out, and the back end refuses one), and a
 * BGP password is write-only: never read, sent only when typed.
 */

import useSWR from "swr"

import { ApiError, fetcher } from "@/lib/api"
import { routerApi } from "@/lib/types"

export interface TypedInterface {
  name: string
  kind: string
  description: string
  mtu: number
  shutdown: boolean
  ipv4: string[]
  ipv6: string[]
  cgnat_role: string
  vrf: number
  linux_name: string
  vlan_outer: number
  vlan_inner: number
  mac_address: string
  urpf: string
  router_advertisements: boolean
}

export interface TypedPool {
  name: string
  prefix_inside: string[]
  prefix_outside: string[]
  block_size: number
  port_first: number
  port_last: number
  policy: string
  mode: string
  vrf?: number | null
  outside_vrf?: number | null
  timeouts: Record<string, number>
  max_blocks: number
  initial_allocation: number
  block_stride: number
  reserve: number
  bypass_source: string[]
  bypass_destination: string[]
  utilisation_alarm: number
  max_sessions: number
  max_session_rate: number
  tcp_mss: string
  filter: string
  algs: Record<string, boolean>
}

export interface TypedCollector {
  transport: "udp" | "tcp" | "syslog"
  configured: boolean
  collector: string
  port: number
  source: string
  enterprise: number
  facility?: number | null
  severity?: number | null
}

export interface TypedLogging {
  enabled: boolean
  collectors: TypedCollector[]
}

export interface TypedStaticRoute {
  prefix: string
  next_hop: string
  distance: number
  tag: number
  description: string
  vrf: string
  family: string
  extra: string[]
  line: string
}

export interface TypedRedistribute {
  protocol: string
  route_map: string
  metric: number
  metric_type: string
  level: string
  statement: string
}

export interface TypedBgpNeighbor {
  address: string
  remote_as: string
  description: string
  update_source: string
  keepalive: number
  holdtime: number
  /** Whether a password is set; the password itself is never read. */
  password_set: boolean
  peer_group: string
  is_peer_group: boolean
  ebgp_multihop: number
  shutdown: boolean
  bfd: boolean
  other: string[]
}

export interface TypedBgpNeighborFamily {
  neighbor: string
  activate: boolean
  route_map_in: string
  route_map_out: string
  prefix_list_in: string
  prefix_list_out: string
  maximum_prefix: number
  next_hop_self: boolean
  soft_reconfiguration_inbound: boolean
  default_originate: boolean
  other: string[]
}

export interface TypedBgpFamily {
  afi: string
  safi: string
  networks: string[]
  aggregates: { prefix: string; summary_only: boolean; as_set: boolean }[]
  redistribute: TypedRedistribute[]
  neighbors: TypedBgpNeighborFamily[]
  other: string[]
}

export interface TypedBgp {
  asn: string
  vrf: string
  router_id: string
  neighbors: TypedBgpNeighbor[]
  families: TypedBgpFamily[]
  other: string[]
  default_ipv4_unicast: boolean
}

export interface TypedOspf {
  version: number
  vrf: string
  router_id: string
  networks: { prefix: string; area: string }[]
  areas: { area: string; area_type: string; no_summary: boolean; other: string[] }[]
  passive_default: boolean
  passive: string[]
  not_passive: string[]
  redistribute: TypedRedistribute[]
  default_information: string
  other: string[]
}

export interface TypedInterfaceRouting {
  name: string
  ospf_area: string
  ospf_cost: number
  ospf_passive: boolean
  ospf_network: string
  ospf_hello: number
  ospf_dead: number
  ospf6_area: string
  ospf6_cost: number
  ospf6_passive: boolean
  isis_instances: string[]
  isis_circuit_type: string
  isis_metric: number
  isis_passive: boolean
  other: string[]
}

export interface TypedConfig {
  source: string
  revision: string
  interfaces: TypedInterface[]
  pools: TypedPool[]
  logging?: TypedLogging | null
  static_routes: TypedStaticRoute[]
  bgp: TypedBgp[]
  ospf: TypedOspf[]
  ospf6: TypedOspf[]
  interface_routing: TypedInterfaceRouting[]
}

export type TypedArea = "interfaces" | "pools" | "logging" | "static" | "bgp" | "ospf" | "ospf6" | "isis" | "interface_routing"

/** What SetConfig sets: one object, and the fields of it that change. */
export type TypedObject =
  | { interface: Partial<TypedInterface> & { name: string } }
  | { pool: Partial<TypedPool> & { name: string } }
  | { logging: Partial<TypedLogging> }
  | { static_route: Partial<TypedStaticRoute> & { prefix: string; next_hop: string } }
  | {
      bgp_neighbor: {
        asn: string
        vrf: string
        neighbor: Partial<TypedBgpNeighbor> & { address: string }
        /** Write only: present only when the operator typed one. */
        password?: string
        families?: { afi: string; safi: string; settings: Partial<TypedBgpNeighborFamily> }[]
      }
    }

export interface TypedDelete {
  area: "interfaces" | "pools" | "logging" | "static" | "bgp"
  name?: string
  transport?: string
  prefix?: string
  next_hop?: string
  asn?: string
  vrf?: string
}

/** One typed call made against the candidate when the changes are reviewed. */
export type TypedEdit = { set: TypedObject; fields: string[] } | { remove: TypedDelete }

/** A SetConfig of `object` naming `fields`; never an empty mask. */
export function typedSet(object: TypedObject, fields: string[]): TypedEdit {
  if (fields.length === 0) throw new Error("a typed edit names its fields: an empty mask sets every field")
  return { set: object, fields }
}

export interface SetConfigResponse {
  path: string[]
  lines: string[]
  output: string
}

/**
 * GetConfig for `areas`: `typed` is true once the box answered them, false
 * when it does not have the call or the area (the back end answers 501), and
 * undefined while unknown. Only a 501 selects the line implementation: a box
 * that types the area but failed to answer now is not handed lines it would
 * take differently (a bare `no neighbor` is refused there), so `error` says why.
 */
export function useTypedConfig(routerId: string, areas: TypedArea[]) {
  const key = routerApi(routerId, `/config/typed?areas=${areas.join(",")}`)
  const r = useSWR<TypedConfig>(key, fetcher, { shouldRetryOnError: false, revalidateOnFocus: false })
  const unimplemented = r.error instanceof ApiError && r.error.code === "router_unimplemented"
  const typed = r.data ? true : unimplemented ? false : undefined
  return { config: r.data, typed, error: unimplemented ? undefined : (r.error as Error | undefined), mutate: r.mutate }
}

/** A number field the box reads 0 when not stated: "" for the forms. */
export const n2s = (v: number | null | undefined, unset = 0) => (v === undefined || v === null || v === unset ? "" : String(v))
/** And back: "" is the box's "not stated". */
export const s2n = (v: string, unset = 0) => (v.trim() === "" ? unset : Number(v.trim()))

/** Words for the staged list: `field value` per named field, the password never shown. */
export function describeSet(fields: string[], values: Record<string, unknown>): string[] {
  return fields.map((f) => {
    if (f === "password") return "password (set, not shown)"
    const v = values[f]
    const text = Array.isArray(v) ? v.join(", ") || "none" : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "")
    return `${f} ${text === "" ? "(cleared)" : text}`
  })
}
