//! Registry of Prisma routers, the gRPC channel of each one and the fleet monitor.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use prisma_proto::v1::config_service_client::ConfigServiceClient;
use prisma_proto::v1::operational_service_client::OperationalServiceClient;
use prisma_proto::v1::session_service_client::SessionServiceClient;
use prisma_proto::v1::route_service_client::RouteServiceClient;
use prisma_proto::v1::telemetry_service_client::TelemetryServiceClient;
use prisma_proto::v1::{
    GetRunningRequest, GetSessionsSummaryRequest, GetSystemRequest, GetVersionRequest, SessionsSummary, SystemInfo,
    VersionInfo, WhoAmIRequest, WhoAmIResponse,
};
use serde::Serialize;
use tonic_health::pb::health_check_response::ServingStatus;
use tonic_health::pb::health_client::HealthClient;
use tonic_health::pb::HealthCheckRequest;
use sqlx::PgPool;
use tokio::task::JoinSet;
use tonic::transport::{Channel, Endpoint};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::grpc;
use crate::telemetry::Telemetry;
use crate::tls;

/// Fleet monitor interval and maximum response time of each Prisma.
const MONITOR_INTERVAL: Duration = Duration::from_secs(5);
const STATUS_TIMEOUT: Duration = Duration::from_secs(4);
/// How long the hostname taken from `GetRunning` stays valid (see `hostname_fallback`).
const HOSTNAME_TTL: Duration = Duration::from_secs(600);
/// How long the account's role from `WhoAmI` stays valid: a role changes only
/// when someone edits the box's logins.
const ACCESS_TTL: Duration = Duration::from_secs(60);

type HostnameCache = Arc<RwLock<HashMap<Uuid, (String, Instant)>>>;
/// `None` inside: the box has no `WhoAmI` (older than 0.149.2), role unknown.
type AccessCache = Arc<RwLock<HashMap<Uuid, (Option<WhoAmIResponse>, Instant)>>>;

pub struct RouterHandle {
    pub id: Uuid,
    pub name: String,
    pub api_url: String,
    channel: Channel,
    /// Why this router cannot be dialled (plaintext not allowed, a TLS profile
    /// gone); it stays listed with the reason instead of failing the fleet.
    unusable: Option<String>,
}

impl RouterHandle {
    pub fn ops(&self) -> OperationalServiceClient<Channel> {
        OperationalServiceClient::new(self.channel.clone())
    }

    pub fn config(&self) -> ConfigServiceClient<Channel> {
        ConfigServiceClient::new(self.channel.clone())
    }

    pub fn telemetry(&self) -> TelemetryServiceClient<Channel> {
        TelemetryServiceClient::new(self.channel.clone())
    }

    pub fn system(&self) -> prisma_proto::v1::system_service_client::SystemServiceClient<Channel> {
        prisma_proto::v1::system_service_client::SystemServiceClient::new(self.channel.clone())
    }

    pub fn session(&self) -> SessionServiceClient<Channel> {
        SessionServiceClient::new(self.channel.clone())
    }

    /// The typed routing table (Prisma 0.149.2, #27); older boxes answer UNIMPLEMENTED.
    pub fn routes(&self) -> RouteServiceClient<Channel> {
        RouteServiceClient::new(self.channel.clone())
    }
}

#[derive(Clone, Serialize)]
pub struct RouterStatus {
    pub id: Uuid,
    pub name: String,
    pub online: bool,
    pub version: Option<VersionInfo>,
    pub system: Option<SystemInfo>,
    pub sessions: Option<SessionsSummary>,
    pub error: Option<String>,
    pub latency_ms: Option<u64>,
    pub checked_at: chrono::DateTime<chrono::Utc>,
    /// Prisma did not answer because a console command is holding the
    /// account's process; the data is from the last query (issue #14).
    pub busy: bool,
    /// Account and role the box gives prisma-web (`WhoAmI`); `None` when the
    /// box cannot tell (older than 0.149.2) or has not answered yet (#28).
    pub access: Option<WhoAmIResponse>,
    /// grpc.health.v1 of `OperationalService`: `serving`, or `not-serving`
    /// while the dataplane's statistics do not answer; `None` when the box has
    /// no health service (older than 0.149.2) or did not answer it (#29).
    pub health: Option<&'static str>,
    /// grpc.health.v1 of `prisma.v1.LogExport` (Prisma 0.149.15): `not-serving`
    /// while a configured CGNAT log stream is stalled; `None` on older boxes (#34).
    pub log_export: Option<&'static str>,
    /// grpc.health.v1 of `prisma.v1.SystemService` (Prisma 0.149.25): `Some`
    /// on a box that has `SystemService` and `OperationalService.Clear` (#48).
    pub system_service: Option<&'static str>,
    /// Set while prisma-web knows the box is in maintenance: an upgrade, a
    /// reboot or a shutdown it asked for (#50).
    pub maintenance: Option<Maintenance>,
}

/// A box in maintenance (#50): from an upgrade's `STARTED` until `api_away_seconds`
/// after its `API_RESTART`, or from a reboot until it answers again.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Maintenance {
    /// `upgrade`, `reboot`, `shutdown` or `dataplane` (a restart that took the box off the network).
    pub what: String,
    pub since: chrono::DateTime<chrono::Utc>,
    /// When it ends; `None` until the box says (an upgrade's API_RESTART) or answers again.
    pub until: Option<chrono::DateTime<chrono::Utc>>,
}

/// How often a box in maintenance with no `until` is probed: a quarter of the time since it
/// began, from 15 s up to 60 s (#52). On 0.149.25-0.149.26 each connection during a restart
/// counts against the API socket's trigger limit (prismarouting #564).
pub fn probe_interval(elapsed: chrono::Duration) -> Duration {
    let quarter = elapsed.to_std().unwrap_or_default() / 4;
    quarter.clamp(Duration::from_secs(15), Duration::from_secs(60))
}

impl Maintenance {
    /// Whether the monitor leaves the box alone now (#52): before `until`, not at all; with no
    /// `until`, unless a probe is due (`last` is the last probe).
    pub fn quiet(&self, now: chrono::DateTime<chrono::Utc>, last: Option<Instant>) -> bool {
        match self.until {
            Some(until) => now < until,
            None => last.is_some_and(|l| l.elapsed() < probe_interval(now - self.since)),
        }
    }

    /// Whether it still holds: before `until`, or with no `until`, while the box has not
    /// answered again since a minute after it began (a reboot answers before it goes down).
    /// A shutdown holds until the box answers again, however long.
    pub fn holds(&self, now: chrono::DateTime<chrono::Utc>, online: bool) -> bool {
        match self.until {
            Some(until) => now < until,
            None => !(online && now - self.since > chrono::Duration::seconds(60)),
        }
    }
}

pub struct Registry {
    db: PgPool,
    /// Root of the TLS profiles mounted in the container (`PRISMA_TLS_DIR`).
    pub tls_root: PathBuf,
    /// `PRISMA_ALLOW_PLAINTEXT` (#35).
    pub allow_plaintext: bool,
    pub telemetry: Telemetry,
    cache: RwLock<HashMap<Uuid, Arc<RouterHandle>>>,
    status: RwLock<HashMap<Uuid, RouterStatus>>,
    hostnames: HostnameCache,
    access: AccessCache,
    /// Console `Show` in progress, per router.
    consoles: Arc<std::sync::Mutex<HashMap<Uuid, usize>>>,
    /// Boxes in maintenance (#50).
    maintenance: std::sync::Mutex<HashMap<Uuid, Maintenance>>,
    /// When the monitor last probed a box in maintenance (#52).
    probes: std::sync::Mutex<HashMap<Uuid, Instant>>,
}

/// Marks a console command as in progress for as long as it exists.
pub struct ConsoleGuard {
    id: Uuid,
    consoles: Arc<std::sync::Mutex<HashMap<Uuid, usize>>>,
}

impl Drop for ConsoleGuard {
    fn drop(&mut self) {
        let mut m = self.consoles.lock().unwrap();
        if let Some(n) = m.get_mut(&self.id) {
            *n -= 1;
            if *n == 0 {
                m.remove(&self.id);
            }
        }
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    id: Uuid,
    name: String,
    api_url: String,
    tls_profile: Option<String>,
    tls_server_name: Option<String>,
}

/// TLS profile and server name of a router reached through `https://`.
pub struct TlsTarget<'a> {
    pub profile: &'a str,
    pub server_name: &'a str,
}

impl Registry {
    pub fn new(db: PgPool, tls_root: PathBuf, allow_plaintext: bool) -> Self {
        Self {
            allow_plaintext,
            telemetry: Telemetry::new(db.clone()),
            tls_root,
            db,
            cache: RwLock::new(HashMap::new()),
            status: RwLock::new(HashMap::new()),
            hostnames: Arc::new(RwLock::new(HashMap::new())),
            access: Arc::new(RwLock::new(HashMap::new())),
            consoles: Arc::new(std::sync::Mutex::new(HashMap::new())),
            maintenance: std::sync::Mutex::new(HashMap::new()),
            probes: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// The router's handle, for calls to it; refused when it cannot be dialled.
    pub async fn get(&self, id: Uuid) -> AppResult<Arc<RouterHandle>> {
        let h = self.load(id).await?;
        match &h.unusable {
            Some(why) => Err(AppError::BadRequest(why.clone())),
            None => Ok(h),
        }
    }

    async fn load(&self, id: Uuid) -> AppResult<Arc<RouterHandle>> {
        if let Some(h) = self.cache.read().unwrap().get(&id) {
            return Ok(h.clone());
        }
        let row = sqlx::query_as::<_, Row>(
            "SELECT id, name, api_url, tls_profile, tls_server_name FROM routers WHERE id = $1",
        )
            .bind(id)
            .fetch_optional(&self.db)
            .await?
            .ok_or_else(|| AppError::NotFound("router not found".into()))?;
        let tls = row
            .tls_profile
            .as_deref()
            .zip(row.tls_server_name.as_deref())
            .map(|(profile, server_name)| TlsTarget { profile, server_name });
        let (channel, unusable) = match self.channel(&row.api_url, tls) {
            Ok(c) => (c, None),
            // Still a channel, never dialled: the handle carries the reason.
            Err(e) => (Endpoint::from_static("http://[::1]:9").connect_lazy(), Some(e.to_string())),
        };
        let handle = Arc::new(RouterHandle { channel, unusable, id: row.id, name: row.name, api_url: row.api_url });
        self.cache.write().unwrap().insert(id, handle.clone());
        Ok(handle)
    }

    /// Every registered router, ordered by name.
    pub async fn all(&self) -> AppResult<Vec<Arc<RouterHandle>>> {
        let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM routers ORDER BY lower(name)")
            .fetch_all(&self.db)
            .await?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            out.push(self.load(id).await?);
        }
        Ok(out)
    }

    /// On Prisma 0.148.4/0.148.5 `Show` shares the account's process with the
    /// reads, and it serves one call at a time: a long `ping` makes the monitor
    /// time out. The console reports here while it runs (issue #14).
    pub fn console_started(&self, id: Uuid) -> ConsoleGuard {
        *self.consoles.lock().unwrap().entry(id).or_default() += 1;
        ConsoleGuard { id, consoles: self.consoles.clone() }
    }

    /// The router's account and role, from the monitor's cache or asked now.
    pub async fn access(&self, h: &RouterHandle) -> Option<WhoAmIResponse> {
        who_am_i(h, &self.access).await
    }

    fn console_active(&self, id: Uuid) -> bool {
        self.consoles.lock().unwrap().contains_key(&id)
    }

    /// Called when a router is edited or removed: drops its channel, status and collector.
    pub fn invalidate(&self, id: Uuid) {
        self.cache.write().unwrap().remove(&id);
        self.status.write().unwrap().remove(&id);
        self.hostnames.write().unwrap().remove(&id);
        self.access.write().unwrap().remove(&id);
        self.telemetry.stop(id);
    }

    /// Status of every router. Uses the monitor's cache; a router with no
    /// status yet (just registered) is queried now.
    pub async fn fleet_status(&self) -> AppResult<Vec<RouterStatus>> {
        let handles = self.all().await?;
        let missing: Vec<_> = {
            let cache = self.status.read().unwrap();
            handles.iter().filter(|h| !cache.contains_key(&h.id)).cloned().collect()
        };
        self.poll(missing).await;
        self.expire_maintenance();
        let cache = self.status.read().unwrap();
        let m = self.maintenance.lock().unwrap();
        Ok(handles
            .iter()
            .filter_map(|h| cache.get(&h.id).cloned())
            .map(|mut st| {
                st.maintenance = m.get(&st.id).cloned();
                st
            })
            .collect())
    }

    /// The box enters maintenance (#50); `until` when it is known.
    pub fn maintenance_begin(&self, id: Uuid, what: &str, until: Option<chrono::DateTime<chrono::Utc>>) {
        let since = chrono::Utc::now();
        self.maintenance.lock().unwrap().insert(id, Maintenance { what: what.into(), since, until });
        // The first probe waits its interval too: the box is going down now.
        self.probes.lock().unwrap().insert(id, Instant::now());
        // No telemetry stream reconnecting to it meanwhile (#52).
        self.telemetry.stop(id);
    }

    /// Whether the box is in maintenance (it may still be due a probe).
    fn in_maintenance(&self, id: Uuid) -> bool {
        self.maintenance.lock().unwrap().contains_key(&id)
    }

    /// Whether the monitor skips the box this round (#52); a due probe is recorded.
    fn quiet(&self, id: Uuid) -> bool {
        let m = self.maintenance.lock().unwrap();
        let Some(m) = m.get(&id) else { return false };
        let mut probes = self.probes.lock().unwrap();
        if m.quiet(chrono::Utc::now(), probes.get(&id).copied()) {
            return true;
        }
        probes.insert(id, Instant::now());
        false
    }

    /// The box said when it is back (an upgrade's API_RESTART with `api_away_seconds`).
    pub fn maintenance_until(&self, id: Uuid, until: chrono::DateTime<chrono::Utc>) {
        if let Some(m) = self.maintenance.lock().unwrap().get_mut(&id) {
            m.until = Some(until);
        }
    }

    pub fn maintenance_end(&self, id: Uuid) {
        self.maintenance.lock().unwrap().remove(&id);
        self.probes.lock().unwrap().remove(&id);
    }

    /// Ends the maintenance that no longer holds, by the monitor's last status: the box is
    /// polled and streamed as before right away, not when someone next reads the fleet (#52).
    fn expire_maintenance(&self) {
        let now = chrono::Utc::now();
        let cache = self.status.read().unwrap();
        let done: Vec<Uuid> = self
            .maintenance
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, m)| !m.holds(now, cache.get(id).is_some_and(|s| s.online)))
            .map(|(id, _)| *id)
            .collect();
        drop(cache);
        for id in done {
            self.maintenance_end(id);
        }
    }

    /// Queries the routers in parallel and updates the status cache.
    async fn poll(&self, handles: Vec<Arc<RouterHandle>>) {
        let mut set = JoinSet::new();
        for h in handles {
            let hostnames = self.hostnames.clone();
            let access = self.access.clone();
            set.spawn(async move {
                if let Some(why) = &h.unusable {
                    // Not dialled at all: offline, with the reason (#35).
                    return RouterStatus {
                        id: h.id,
                        name: h.name.clone(),
                        online: false,
                        version: None,
                        system: None,
                        sessions: None,
                        error: Some(why.clone()),
                        latency_ms: None,
                        checked_at: chrono::Utc::now(),
                        busy: false,
                        access: None,
                        health: None,
                        log_export: None,
                        system_service: None,
                        maintenance: None,
                    };
                }
                let started = Instant::now();
                let (health, log_export, system_service, res) = tokio::join!(
                    health(&h, "prisma.v1.OperationalService"),
                    health(&h, "prisma.v1.LogExport"),
                    health(&h, "prisma.v1.SystemService"),
                    tokio::time::timeout(STATUS_TIMEOUT, async {
                        let (mut a, mut b, mut c) = (h.ops(), h.ops(), h.ops());
                        tokio::try_join!(
                            a.get_version(GetVersionRequest {}),
                            b.get_system(GetSystemRequest {}),
                            c.get_sessions_summary(GetSessionsSummaryRequest {}),
                        )
                    })
                );
                let latency = started.elapsed().as_millis() as u64;
                let mut st = RouterStatus {
                    id: h.id,
                    name: h.name.clone(),
                    online: false,
                    version: None,
                    system: None,
                    sessions: None,
                    error: None,
                    latency_ms: None,
                    checked_at: chrono::Utc::now(),
                    busy: false,
                    access: None,
                    health,
                    log_export,
                    system_service,
                    maintenance: None,
                };
                match res {
                    Ok(Ok((v, s, ss))) => {
                        st.online = true;
                        st.latency_ms = Some(latency);
                        let (mut v, mut s) = (v.into_inner(), s.into_inner());
                        if v.hostname.is_empty() || s.hostname.is_empty() {
                            if let Some(name) = hostname_fallback(&h, &hostnames).await {
                                if v.hostname.is_empty() {
                                    v.hostname = name.clone();
                                }
                                if s.hostname.is_empty() {
                                    s.hostname = name;
                                }
                            }
                        }
                        st.version = Some(v);
                        st.system = Some(s);
                        st.sessions = Some(ss.into_inner());
                        st.access = who_am_i(&h, &access).await;
                    }
                    Ok(Err(status)) => st.error = Some(grpc::describe(&status)),
                    Err(_) => st.error = Some("timed out".into()),
                }
                if st.health == Some(NOT_SERVING) {
                    // Reachable, but not able to read the dataplane: say so, not "offline".
                    let why = "the API answers but reports NOT_SERVING: the dataplane's statistics do not answer";
                    st.error = Some(match st.error.take() {
                        Some(e) => format!("{why} ({e})"),
                        None => why.into(),
                    });
                }
                st
            });
        }
        for mut st in set.join_all().await {
            if !st.online && self.console_active(st.id) {
                // No answer because the console is holding the account: not an outage.
                let prev = self.status.read().unwrap().get(&st.id).cloned();
                st = match prev.filter(|p| p.online) {
                    Some(p) => RouterStatus { busy: true, ..p },
                    None => RouterStatus { busy: true, error: Some("busy with a console command".into()), ..st },
                };
            }
            self.status.write().unwrap().insert(st.id, st);
        }
    }

    /// Keeps the fleet status and the telemetry collectors up to date, so the
    /// web UI never waits for a slow or unreachable router.
    pub async fn monitor(self: Arc<Self>) {
        let mut tick = tokio::time::interval(MONITOR_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            match self.all().await {
                Ok(handles) => {
                    let ids: Vec<Uuid> = handles.iter().map(|h| h.id).collect();
                    // A box in maintenance gets no telemetry stream and only the probes it is due (#52).
                    for h in handles.iter().filter(|h| h.unusable.is_none() && !self.in_maintenance(h.id)) {
                        self.telemetry.ensure(h.clone());
                    }
                    self.telemetry.retain(&ids);
                    let due: Vec<_> = handles.iter().filter(|h| !self.quiet(h.id)).cloned().collect();
                    self.poll(due).await;
                    self.expire_maintenance();
                    self.status.write().unwrap().retain(|id, _| ids.contains(id));
                }
                Err(e) => tracing::warn!(error = %e, "fleet monitor failed"),
            }
        }
    }
}

impl Registry {
    /// Lazy gRPC channel: connects on the first call and reconnects by itself.
    /// With `tls`, does mTLS with the profile and checks the server name.
    pub fn channel(&self, url: &str, tls: Option<TlsTarget>) -> AppResult<Channel> {
        if let Some(why) = plaintext_refused(url, self.allow_plaintext) {
            return Err(AppError::BadRequest(why));
        }
        let mut endpoint = Endpoint::from_shared(url.to_string())
            .map_err(|e| AppError::BadRequest(format!("invalid address: {e}")))?
            .connect_timeout(Duration::from_secs(3))
            .http2_keep_alive_interval(Duration::from_secs(30))
            .keep_alive_while_idle(true);
        if let Some(t) = tls {
            let cfg = tls::client_config(&self.tls_root, t.profile, t.server_name)?;
            endpoint = endpoint
                .tls_config(cfg)
                .map_err(|e| AppError::BadRequest(format!("invalid TLS configuration: {e}")))?;
        }
        Ok(endpoint.connect_lazy())
    }
}

/// Prisma 0.148.4 returns an empty hostname in GetVersion and does not fill it in
/// GetSystem (a bug confirmed by the Prisma team, fixed in 0.148.6). Until then
/// the name comes from GetRunning's `hostname` line, read at most every 10 min
/// per router. When Prisma fills in the hostname, this is not called at all (issue #13).
async fn hostname_fallback(h: &RouterHandle, cache: &HostnameCache) -> Option<String> {
    if let Some((name, at)) = cache.read().unwrap().get(&h.id) {
        if at.elapsed() < HOSTNAME_TTL {
            return Some(name.clone());
        }
    }
    let running = h.config().get_running(grpc::req(GetRunningRequest {})).await.ok()?.into_inner();
    let name = hostname_from_running(&running.text)?;
    cache.write().unwrap().insert(h.id, (name.clone(), Instant::now()));
    Some(name)
}

const NOT_SERVING: &str = "not-serving";

/// Standard health check of one service: the one the status reads come from,
/// or the log export's.
async fn health(h: &RouterHandle, service: &str) -> Option<&'static str> {
    let mut client = HealthClient::new(h.channel.clone());
    let req = grpc::req(HealthCheckRequest { service: service.into() });
    let resp = tokio::time::timeout(STATUS_TIMEOUT, client.check(req)).await.ok()?.ok()?.into_inner();
    health_word(resp.status)
}

fn health_word(status: i32) -> Option<&'static str> {
    match ServingStatus::try_from(status).ok()? {
        ServingStatus::Serving => Some("serving"),
        ServingStatus::NotServing => Some(NOT_SERVING),
        // UNKNOWN or SERVICE_UNKNOWN: the box cannot tell.
        _ => None,
    }
}

/// `http://` while plaintext is not allowed (#35): the reason, for the user.
pub fn plaintext_refused(url: &str, allow: bool) -> Option<String> {
    (url.starts_with("http://") && !allow).then(|| {
        "a real Prisma only speaks mTLS: use https:// with a TLS profile. Plain http:// is for the \
         simulated Prismas and needs PRISMA_ALLOW_PLAINTEXT=true"
            .to_string()
    })
}

/// `WhoAmI`, at most every minute per router. A box without the rpc is
/// remembered as unknown; a failed call keeps the last answer (#28).
async fn who_am_i(h: &RouterHandle, cache: &AccessCache) -> Option<WhoAmIResponse> {
    let cached = cache.read().unwrap().get(&h.id).cloned();
    if let Some((who, at)) = &cached {
        if at.elapsed() < ACCESS_TTL {
            return who.clone();
        }
    }
    let who = match tokio::time::timeout(STATUS_TIMEOUT, h.session().who_am_i(grpc::req(WhoAmIRequest {}))).await {
        Ok(Ok(r)) => Some(r.into_inner()),
        Ok(Err(s)) if s.code() == tonic::Code::Unimplemented => None,
        _ => return cached.and_then(|(who, _)| who),
    };
    cache.write().unwrap().insert(h.id, (who.clone(), Instant::now()));
    who
}

/// Name in the top-level `hostname <name>` line of a running-config text.
pub fn hostname_from_running(text: &str) -> Option<String> {
    text.lines()
        .find_map(|l| l.strip_prefix("hostname "))
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
}

/// Validates the gRPC address of a Prisma. Accepts IPv6 in brackets.
pub fn validate_api_url(raw: &str) -> AppResult<String> {
    let url = raw.trim().trim_end_matches('/');
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| AppError::BadRequest("the address must start with https:// (mTLS) or http:// (mocks only)".into()))?;
    if rest.contains('/') {
        return Err(AppError::BadRequest("give only host and port, no path: http://host:50051".into()));
    }
    let authority = rest;
    let host = if let Some(v6) = authority.strip_prefix('[') {
        let (addr, after) = v6
            .split_once(']')
            .ok_or_else(|| AppError::BadRequest("IPv6 address without a closing ']'".into()))?;
        addr.parse::<std::net::Ipv6Addr>()
            .map_err(|_| AppError::BadRequest(format!("invalid IPv6: {addr}")))?;
        if !(after.is_empty() || after.strip_prefix(':').is_some_and(valid_port)) {
            return Err(AppError::BadRequest("invalid port".into()));
        }
        addr
    } else {
        if authority.matches(':').count() > 1 {
            return Err(AppError::BadRequest(
                "IPv6 addresses must be in brackets: http://[2001:db8::1]:50051".into(),
            ));
        }
        let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
        if !port.is_empty() && !valid_port(port) {
            return Err(AppError::BadRequest("invalid port".into()));
        }
        host
    };
    if host.is_empty() || authority.contains('@') {
        return Err(AppError::BadRequest("address without a valid host".into()));
    }
    Ok(url.to_string())
}

fn valid_port(p: &str) -> bool {
    p.parse::<u16>().is_ok_and(|n| n > 0)
}

#[cfg(test)]
mod tests {
    use super::validate_api_url as v;

    #[test]
    fn accepts_v4_v6_and_names() {
        for ok in [
            "http://prisma-mock:50051",
            "http://192.0.2.1:50051",
            "http://[2001:db8::1]:50051",
            "http://[fd00::1]",
            "https://192.0.2.166:50051",
            "https://[2001:db8::1]:50051",
        ] {
            assert!(v(ok).is_ok(), "{ok}");
        }
        assert_eq!(v("http://x:1/").unwrap(), "http://x:1");
    }

    #[test]
    fn rejects_bad_urls() {
        for bad in [
            "ftp://x",
            "prisma:50051",
            "http://x:1/v1",
            "http://2001:db8::1:50051",
            "http://[2001:db8::zz]:80",
            "http://[2001:db8::1]:99999",
            "http://user@host",
            "http://",
        ] {
            assert!(v(bad).is_err(), "{bad}");
        }
    }
}

#[cfg(test)]
mod plaintext_tests {
    use super::plaintext_refused;

    #[test]
    fn plaintext_only_when_allowed() {
        assert!(plaintext_refused("http://192.0.2.198:50051", false).is_some_and(|m| m.contains("https://")));
        assert_eq!(plaintext_refused("http://prisma-mock:50051", true), None);
        assert_eq!(plaintext_refused("https://192.0.2.166:50051", false), None);
    }
}

#[cfg(test)]
mod health_tests {
    use super::health_word;

    #[test]
    fn not_serving_is_its_own_state_and_unknown_is_none() {
        assert_eq!(health_word(1), Some("serving"));
        assert_eq!(health_word(2), Some("not-serving"));
        assert_eq!(health_word(0), None);
        assert_eq!(health_word(3), None, "SERVICE_UNKNOWN");
    }
}

#[cfg(test)]
mod hostname_tests {
    use super::hostname_from_running;

    #[test]
    fn hostname_comes_from_the_running_config() {
        let running = "! cgnat\nhostname prisma-routing\ninterface enp6s18\n ipv4 address 192.0.2.166/24\n exit\n";
        assert_eq!(hostname_from_running(running).as_deref(), Some("prisma-routing"));
        // Top-level line only: a nested `description hostname x` does not count.
        assert_eq!(hostname_from_running(" description hostname fake\n"), None);
        assert_eq!(hostname_from_running("hostname   \n"), None);
    }
}

#[cfg(test)]
mod maintenance_tests {
    use super::Maintenance;
    use chrono::{Duration, Utc};

    #[test]
    fn maintenance_holds_until_the_box_says_or_answers_again() {
        let now = Utc::now();
        let up = Maintenance { what: "upgrade".into(), since: now - Duration::seconds(100), until: Some(now + Duration::seconds(5)) };
        assert!(up.holds(now, true), "until api_away_seconds pass, even if it answers");
        assert!(!up.holds(now + Duration::seconds(6), false));
        let reboot = Maintenance { what: "reboot".into(), since: now, until: None };
        assert!(reboot.holds(now + Duration::seconds(10), true), "the reply comes before the box goes down");
        assert!(reboot.holds(now + Duration::seconds(90), false));
        assert!(!reboot.holds(now + Duration::seconds(90), true), "back once it answers again");
    }

    #[test]
    fn a_box_in_maintenance_is_probed_sparingly() {
        use std::time::Instant;
        let now = Utc::now();
        assert_eq!(super::probe_interval(Duration::seconds(10)).as_secs(), 15);
        assert_eq!(super::probe_interval(Duration::seconds(120)).as_secs(), 30);
        assert_eq!(super::probe_interval(Duration::seconds(3600)).as_secs(), 60);
        let up = Maintenance { what: "upgrade".into(), since: now, until: Some(now + Duration::seconds(60)) };
        assert!(up.quiet(now, None), "not called before the time the box gave");
        assert!(!up.quiet(now + Duration::seconds(61), Some(Instant::now())));
        let reboot = Maintenance { what: "reboot".into(), since: now - Duration::seconds(30), until: None };
        assert!(reboot.quiet(now, Some(Instant::now())), "probed at most every 15 s");
        assert!(!reboot.quiet(now, None), "a probe is due when none was made");
    }
}
