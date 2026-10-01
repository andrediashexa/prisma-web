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

// ---- prisma.v1 (back/proto/prisma/v1/prisma.proto), como o back entrega em JSON

export interface VersionInfo {
  release: string
  plugin_build: string
  dataplane_current: boolean
  vpp_version: string
  frr_version: string
  hostname: string
  api_transport: string
}

export interface SystemInfo {
  hostname: string
  uptime_seconds: number
  control_plane_cpus: string
  main_thread_cpu: string
  worker_cpus: string
  workers: number
  hugepages: number
  cpu_text: string
  memory_text: string
}

export interface SessionsSummary {
  sessions: number
  sessions_fit: number
  subscribers: number
  ports_in_use: number
}

export interface InterfaceCounters {
  rx_bytes: number
  tx_bytes: number
  rx_packets: number
  tx_packets: number
  rx_errors: number
  tx_errors: number
  drops: number
}

export interface RouterInterface {
  name: string
  admin_up: boolean
  link_up: boolean
  mtu: number
  mac_address: string
  /** Notação CIDR, IPv4 e IPv6 misturados. */
  addresses: string[]
  linux_name: string
  description: string
  counters: InterfaceCounters | null
}

export interface Pool {
  name: string
  mode: string
  policy: string
  block_size: number
  prefixes_inside: string[]
  prefixes_outside: string[]
  capacity: number
  guaranteed: number
  subscribers: number
  ports_in_use: number
  refusals: number
  sessions: number
}

export interface Subscriber {
  address: string
  pool: string
  blocks: { public_address: string; first_port: number; last_port: number }[]
  sessions: number
  text: string
}

export interface BgpNeighbor {
  vrf: string
  peer: string
  remote_as: number
  state: string
  uptime_seconds: number
  prefixes_received: number
  description: string
}

export interface OspfNeighbor {
  protocol: string
  router_id: string
  address: string
  interface: string
  state: string
}

export interface IsisAdjacency {
  system_id: string
  interface: string
  state: string
  level: string
}

export interface VrrpRouter {
  interface: string
  vr_id: number
  family: number
  state: string
  priority: number
  addresses: string[]
}

export interface Bundle {
  name: string
  mode: string
  members: string[]
  active_members: string[]
}

export interface Diagnostic {
  severity: "error" | "warning" | "note" | "unspecified"
  message: string
  path: string[]
  line: string
}

export interface ConfigText {
  text: string
  revision: string
}

export interface OpenCandidateResponse {
  candidate_id: string
  base_revision: string
  text: string
}

export interface EditResponse {
  diagnostics: Diagnostic[]
  output: string
}

export interface CompareResponse {
  diff: string
  changed: boolean
}

export interface CheckResponse {
  passed: boolean
  diagnostics: Diagnostic[]
  remap: string[]
  cutoff: string[]
  diverge: string[]
  output: string
}

export interface CommitResponse {
  revision: string
  confirm_deadline: string | null
  diagnostics: Diagnostic[]
  output: string
}

export interface Revision {
  number: number
  committed_at: string | null
  comment: string
}

export interface PendingConfirm {
  deadline: string | null
  by: string
  revision: string | null
  can_confirm: boolean
}

export interface Series<T> {
  step_seconds: number
  samples: T[]
  /** false quando o stream de telemetria do roteador está caído. */
  live: boolean
}

export interface RateSample {
  timestamp: string
  rx_bps: number
  tx_bps: number
}

export interface CgnatSample {
  timestamp: string
  subscribers: number
  ports_in_use: number
  sessions: number
  refusals: number
}

export interface TrafficSeries extends Series<RateSample> {
  interface: string
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
  /** Perfil TLS (diretório de certificados no host); null nos mocks sem TLS. */
  tls_profile: string | null
  tls_server_name: string | null
  /** CN do certificado do perfil: a conta que o Prisma vê. */
  tls_account: string | null
  created_at: string
  updated_at: string
}

export interface RouterStatus {
  id: string
  name: string
  online: boolean
  version: VersionInfo | null
  system: SystemInfo | null
  sessions: SessionsSummary | null
  /** Sem resposta porque um comando do console ocupa a conta; dados da última consulta. */
  busy: boolean
  error: string | null
  latency_ms: number | null
}

/** Caminho da API de um roteador específico: `/routers/{id}/...`. */
export function routerApi(id: string, path: string) {
  return `/routers/${encodeURIComponent(id)}${path}`
}

export interface TlsProfile {
  id: string
  account: string | null
  ca: string | null
  not_after: string | null
  error: string | null
}
