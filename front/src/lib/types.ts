// Mirrors the types from back/crates/prisma-api and the back-end routes.

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

// ---- prisma.v1 (back/proto/prisma/v1/prisma.proto), as the back end serves it in JSON

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
  // Uptime breakdown, Prisma 0.148.7 (#20). null when the box could not read it.
  boot_time?: string | null
  dataplane_started?: string | null
  control_plane_started?: string | null
  vty_started?: string | null
  /** Verbatim, as recorded by the box ("system reboot by <account>", "not recorded"). */
  last_boot_reason?: string
  release_installed_at?: string | null
  /** The dataplane started more than five minutes after the box: it restarted by itself. */
  dataplane_restarted?: boolean
  // Memory and worker load in numbers, Prisma 0.149.2 (#25). 0 / empty on older boxes.
  /** The host's RAM, from the kernel's meminfo. */
  memory_total_bytes?: number
  /** MemTotal less MemAvailable: the dataplane's hugepages count as used. */
  memory_used_bytes?: number
  /** Of the used, the 1G hugepages reserved for the dataplane. */
  memory_hugepages_bytes?: number
  worker_load?: WorkerLoad[]
}

/** One dataplane worker's load, as the dataplane counts it (Prisma 0.149.2). */
export interface WorkerLoad {
  /** 0 is the dataplane's vpp_wk_0. */
  worker: number
  cpu: number
  /** Packets per graph call: near 0 idle, up to 256 with full frames. */
  vectors_per_call: number
  /** VPP's share of node clocks, 0 to 1: a saturated worker reads about 0.5. */
  busy_ratio: number
  /** Main loop rate; under 1,000 the worker waits for interrupts. */
  loops_per_second: number
  busy_window_ms: number
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
  /** CIDR notation, IPv4 and IPv6 mixed. */
  addresses: string[]
  linux_name: string
  description: string
  counters: InterfaceCounters | null
  /** Link speed (Prisma 0.149.2); 0 or 4294967295000 mean unknown, see knownSpeed(). */
  speed_bps?: number
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
  /** Prisma 0.151.0 (#68): "cgnat" or "nat64". */
  level?: string
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
  /** When the box closes it if nobody uses it (Prisma 0.149.18); null on an older box. */
  expires_at?: string | null
  idle_seconds?: number
}

export interface EditResponse {
  diagnostics: Diagnostic[]
  output: string
  /** The box's new expiry after this edit (Prisma 0.149.18). */
  expires_at?: string | null
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
  /** What a commit would be refused for, by name (Prisma 0.149.18); "unspecified" when it would pass. */
  reason?: string
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
  /** The deadline passed and the box is still on the unconfirmed configuration (Prisma 0.149.18). */
  overdue?: boolean
  revert_attempts?: number
  /** "box": read with GetPendingConfirm; "memory": kept by prisma-web for an older box. */
  source?: "box" | "memory"
}

export interface Series<T> {
  step_seconds: number
  samples: T[]
  /** false when the router's telemetry stream is down. */
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

/** Limits mirrored from prisma_api::MTU_MIN/MTU_MAX. */
export const MTU_MIN = 1280
export const MTU_MAX = 9216
export const PASSWORD_MIN_LEN = 10

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Administrator",
  operator: "Operator",
  viewer: "Read-only",
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }

export function hasRole(user: CurrentUser | undefined, role: Role) {
  return !!user && ROLE_RANK[user.role] >= ROLE_RANK[role]
}

/** For screens of one router: the role there may differ from the global one (#6). */
export function roleAtLeast(role: Role | undefined, min: Role) {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[min]
}

/** A user's override on one router; null: the global role applies. */
export interface RouterAccess {
  router_id: string
  router_name: string
  role: "none" | Role | null
}

export interface RouterView {
  id: string
  name: string
  api_url: string
  description: string | null
  /** TLS profile (certificate directory on the host); null for mocks without TLS. */
  tls_profile: string | null
  tls_server_name: string | null
  /** CN of the profile's certificate: the account Prisma sees. */
  tls_account: string | null
  /** The signed-in user's role on this router: the global one, or its override there (#6). */
  my_role: Role
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
  /** No response because a console command holds the account; data from the last poll. */
  busy: boolean
  error: string | null
  latency_ms: number | null
  /** Account and role the box gives prisma-web (WhoAmI); null when unknown (box older than 0.149.2). */
  access: WhoAmI | null
  /** grpc.health.v1: "not-serving" while the dataplane's statistics do not answer; null when the box cannot tell. */
  health: "serving" | "not-serving" | null
  /** grpc.health.v1 of prisma.v1.LogExport (Prisma 0.149.15): "not-serving" while a configured CGNAT log stream is stalled. */
  log_export: "serving" | "not-serving" | null
  /** grpc.health.v1 of prisma.v1.SystemService (Prisma 0.149.25): set on a box that has Clear (#48). */
  system_service: "serving" | "not-serving" | null
  /** Set while prisma-web knows the box is in maintenance: an upgrade, reboot or shutdown it asked for (#50). */
  maintenance: { what: "upgrade" | "reboot" | "shutdown" | "dataplane"; since: string; until: string | null } | null
}

/** SystemService's UpgradeProgress (Prisma 0.149.25, #50); the phase by name. */
export interface UpgradeProgress {
  phase: "PHASE_UNSPECIFIED" | "CHECKED" | "STARTED" | "DOWNLOAD" | "VERIFY" | "INSTALL" | "INSTALLED" | "API_RESTART" | "FAILED"
  message: string
  version: string
  newest: string
  api_away_seconds: number
  started_at: string | null
  output: string
  diagnostics: { items: Diagnostic[]; output: string; reason?: string } | null
}

/** OperationalService.Clear's targets (Prisma 0.149.25, #48). */
export type ClearTarget = "interface_counters" | "cgnat_subscriber" | "bgp" | "ospf_process" | "ospf_neighbor" | "isis_adjacency"

/** TelemetryService.WatchLogging's events (Prisma 0.149.25, #49); the kind by name. */
export interface WatchedLogEvent {
  kind: "STARTED" | "BOOT" | "ALLOC" | "RELEASE" | "EXHAUSTED" | "DELIVERY" | "LOST" | "KIND_UNSPECIFIED"
  at: string | null
  subscriber: string
  public_address: string
  port_first: number
  port_last: number
  pool: string
  pool_id: number
  identity: string
  stream: string
  collector: string
  carrier: string
  connection: string
  sent: number
  lost: number
  pending_bytes: number
  boot_time: string | null
  exported: boolean
  from_watch_ring: boolean
  pools_named: boolean
  text: string
}

export interface ClearResponse {
  output: string
  command: string
}

/** SessionService.WhoAmI (Prisma 0.149.2). */
export interface WhoAmI {
  account: string
  /** "administrator", "cgnat-operator" or "read-only", the VTY's words. */
  role: string
  can_configure: boolean
  can_configure_cgnat: boolean
  /** Prisma 0.149.26 (#51): the account has `operator` (or is root): upgrade, reboot, shutdown, dataplane restart. */
  can_operate?: boolean
}

/** A login that can change nothing: the back refuses its changes too. */
export function isReadOnly(a: WhoAmI | null | undefined) {
  return !!a && !a.can_configure && !a.can_configure_cgnat
}

/** API path for a specific router: `/routers/{id}/...`. */
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

// Routing policies, Prisma 0.148.12 (#21).
export interface PolicyTerm {
  name: string
  /** "accept", "reject", "next term", "next policy", or "" when it has none. */
  then: string
  lines: string[]
}

export interface Policy {
  name: string
  terms: PolicyTerm[]
  default_action: string
  text: string
  applied: string[]
}

export interface PolicyTermHits {
  policy: string
  /** "" is the policy's default-action. */
  term: string
  hits: number
  /** false: the term compiled to no clause at this use. */
  compiled: boolean
}

export interface PolicyUseCounters {
  policy: string
  attach_point: string
  applied_at: string[]
  route_map: string
  daemon: string
  called: boolean
  /** false: the daemon reported no such map — no counter, which is not zero. */
  counted: boolean
  terms: PolicyTermHits[]
}

export interface TestPolicyStep {
  policy: string
  term: string
  outcome: "match" | "no match" | "unknown" | string
  why: string
}

export interface TestPolicyResponse {
  verdict: "accept" | "reject" | string
  decided_by: string
  decided_policy: string
  decided_term: string
  attach_point: string
  route_map: string
  daemon: string
  route: Record<string, string>
  route_after: Record<string, string>
  steps: TestPolicyStep[]
  assumed: string[]
  notes: string[]
  said: string[]
  refused: string[]
}

// Typed routing table, RouteService of Prisma 0.149.2 (#27).
export interface RouteNextHop {
  /** Empty for a route straight onto an interface. */
  address: string
  interface: string
  active: boolean
  fib: boolean
  weight: number
  directly_connected: boolean
  /** The next hop's VRF when it is not the route's (a leaked route). */
  vrf: string
  /** "blackhole", "reject" or "" for a forwarding next hop. */
  blackhole: string
}

export interface Route {
  vrf: string
  prefix: string
  family: 4 | 6
  protocol: string
  distance: number
  metric: number
  selected: boolean
  installed: boolean
  next_hops: RouteNextHop[]
  table: number
  age_seconds: number
}

export interface ListRoutesResponse {
  routes: Route[]
  /** Empty on the snapshot's last page. */
  next_page_token: string
  /** Meaningful only when total_known. */
  total: number
  total_known: boolean
  snapshot_at: string | null
}

export interface RouteCount {
  vrf: string
  family: 4 | 6
  protocol: string
  rib: number
  fib: number
}

export interface RouteSummary {
  counts: RouteCount[]
}

/** One CGNAT log export stream (GetLogging, Prisma 0.149.15). Counters count from the dataplane's start; a decrease is a reset. */
export interface LogStream {
  kind: "syslog" | "ipfix-tcp" | "ipfix-udp"
  configured: boolean
  collector: string
  source: string
  carrier: string
  carrier_reason: string
  connection: string
  records: number
  bytes_sent: number
  packets_sent: number
  pending_bytes: number
  spill_bytes: number
  spill_cap_bytes: number
  dropped_over_cap: number
  send_failures: number
  dropped: number
  delivering: boolean
  stalled_reason: string
  last_progress: string | null
}

export interface LogEvent {
  at: string
  kind: string
  text: string
}

export interface LoggingState {
  at: string | null
  streams: LogStream[]
  carrier: string
  logger_pid: number
  export_ring_dropped: number
  worker_queue_dropped: number
  exhaustion_repeats_not_reported: number
  transmit_failed: number
  transmit_interface: string
  rings_shared: boolean
  text: string
  /** Recent log-* events, newest first (kept by prisma-web, not in the change log). */
  events: LogEvent[]
}
