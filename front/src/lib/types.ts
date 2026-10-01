// Espelha os tipos de back/crates/prisma-api e das rotas do back.

export type Role = "admin" | "operator" | "viewer"

export interface CurrentUser {
  id: string
  username: string
  role: Role
  must_change_password: boolean
}

export interface UserView {
  id: string
  username: string
  role: Role
  disabled: boolean
  must_change_password: boolean
  created_at: string
  last_login_at: string | null
  active_sessions: number
}

export interface AuditEntry {
  id: number
  at: string
  user_id: string | null
  username: string | null
  action: string
  target: string | null
  router_id: string | null
  success: boolean
  ip: string | null
  details: Record<string, unknown>
}

export interface AuditPage {
  items: AuditEntry[]
  next_before: number | null
}

export interface SystemInfo {
  hostname: string
  version: string
  uptime_seconds: number
  cpu_cores: number
  cpu_percent: number
  memory_total_bytes: number
  memory_used_bytes: number
  load_average: [number, number, number]
  ipv4_forwarding: boolean
  ipv6_forwarding: boolean
}

export type InterfaceKind = "ethernet" | "bridge" | "vlan" | "wireguard" | "loopback"

export interface RouterInterface {
  name: string
  kind: InterfaceKind
  description: string | null
  mac: string | null
  mtu: number
  admin_up: boolean
  oper_state: "up" | "down"
  /** Notação CIDR, IPv4 e IPv6 misturados. */
  addresses: string[]
  counters: {
    rx_bytes: number
    tx_bytes: number
    rx_packets: number
    tx_packets: number
    rx_errors: number
    tx_errors: number
  }
}

export interface InterfaceUpdate {
  description?: string
  mtu?: number
  admin_up?: boolean
}

export interface RouterRoute {
  family: "ipv4" | "ipv6"
  destination: string
  gateway: string | null
  interface: string
  metric: number
  protocol: string
}

export interface TrafficSeries {
  interface: string
  step_seconds: number
  samples: { timestamp: string; rx_bps: number; tx_bps: number }[]
}

/** Limites espelhados de prisma_api::MTU_MIN/MTU_MAX. */
export const MTU_MIN = 1280
export const MTU_MAX = 9216
export const PASSWORD_MIN_LEN = 10

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Administrador",
  operator: "Operador",
  viewer: "Leitura",
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }

export function hasRole(user: CurrentUser | undefined, role: Role) {
  return !!user && ROLE_RANK[user.role] >= ROLE_RANK[role]
}

export interface RouterView {
  id: string
  name: string
  api_url: string
  description: string | null
  has_token: boolean
  created_at: string
  updated_at: string
}

export interface RouterStatus {
  id: string
  name: string
  online: boolean
  system: SystemInfo | null
  error: string | null
  latency_ms: number | null
}

/** Caminho da API de um roteador específico: `/routers/{id}/...`. */
export function routerApi(id: string, path: string) {
  return `/routers/${encodeURIComponent(id)}${path}`
}
