//! Prisma telemetry: one permanent `Subscribe` per router.
//!
//! Prisma delivers live counters; the history (24 h) is built here, in
//! memory, from the differences between samples. The stream's configuration
//! events (commits made on the box itself, automatic rollbacks of
//! `commit confirmed`) go to the change log.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use prisma_proto::v1::telemetry_update::Update;
use prisma_proto::v1::{Event, SubscribeRequest, TelemetryUpdate};
use serde::Serialize;
use serde_json::json;
use sqlx::PgPool;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::audit::{self, Entry};
use crate::registry::RouterHandle;

const SAMPLE_MS: u32 = 5_000;
const RETENTION: Duration = Duration::from_secs(24 * 3600);
const MAX_POINTS: usize = 180;
/// Events that arrive right after an action taken through the web UI are its
/// echo and do not become a second log entry.
const ECHO_WINDOW: Duration = Duration::from_secs(8);

#[derive(Clone, Copy, Serialize)]
pub struct RateSample {
    pub timestamp: DateTime<Utc>,
    pub rx_bps: u64,
    pub tx_bps: u64,
}

#[derive(Clone, Copy, Serialize)]
pub struct CgnatSample {
    pub timestamp: DateTime<Utc>,
    pub subscribers: u64,
    pub ports_in_use: u64,
    pub sessions: u64,
    pub refusals: u64,
}

#[derive(Serialize)]
pub struct Series<T> {
    pub step_seconds: u32,
    pub samples: Vec<T>,
    /// `false` when the router's telemetry stream is down.
    pub live: bool,
}

/// A `commit confirmed` awaiting `Confirm`.
#[derive(Clone, Serialize)]
pub struct PendingConfirm {
    pub deadline: Option<DateTime<Utc>>,
    /// Web user who made the commit, or the box account.
    pub by: String,
    #[serde(skip)]
    pub user_id: Option<Uuid>,
    pub revision: Option<String>,
}

#[derive(Default)]
struct RouterData {
    ifaces: HashMap<String, VecDeque<RateSample>>,
    last: HashMap<String, (DateTime<Utc>, u64, u64)>,
    cgnat: VecDeque<CgnatSample>,
    live: bool,
    pending: Option<PendingConfirm>,
    web_action_at: Option<Instant>,
}

struct Shared {
    db: PgPool,
    routers: Mutex<HashMap<Uuid, RouterData>>,
}

pub struct Telemetry {
    shared: Arc<Shared>,
    collectors: Mutex<HashMap<Uuid, JoinHandle<()>>>,
}

impl Telemetry {
    pub fn new(db: PgPool) -> Self {
        Self {
            shared: Arc::new(Shared { db, routers: Mutex::new(HashMap::new()) }),
            collectors: Mutex::new(HashMap::new()),
        }
    }

    /// Ensures a collector is running for the router.
    pub fn ensure(&self, h: Arc<RouterHandle>) {
        let mut collectors = self.collectors.lock().unwrap();
        if collectors.get(&h.id).is_some_and(|j| !j.is_finished()) {
            return;
        }
        let shared = self.shared.clone();
        collectors.insert(h.id, tokio::spawn(run(h, shared)));
    }

    pub fn stop(&self, id: Uuid) {
        if let Some(j) = self.collectors.lock().unwrap().remove(&id) {
            j.abort();
        }
        self.shared.routers.lock().unwrap().remove(&id);
    }

    /// Stops the collectors of routers that no longer exist.
    pub fn retain(&self, ids: &[Uuid]) {
        let gone: Vec<Uuid> = self.collectors.lock().unwrap().keys().filter(|id| !ids.contains(id)).copied().collect();
        for id in gone {
            self.stop(id);
        }
    }

    pub fn traffic(&self, id: Uuid, iface: &str, minutes: u32) -> Series<RateSample> {
        let routers = self.shared.routers.lock().unwrap();
        let data = routers.get(&id);
        let samples: Vec<RateSample> = data
            .and_then(|d| d.ifaces.get(iface))
            .map(|q| window(q, minutes).copied().collect())
            .unwrap_or_default();
        let (step, samples) = downsample(samples, |c| RateSample {
            timestamp: c.last().unwrap().timestamp,
            rx_bps: avg(c.iter().map(|s| s.rx_bps)),
            tx_bps: avg(c.iter().map(|s| s.tx_bps)),
        });
        Series { step_seconds: step, samples, live: data.is_some_and(|d| d.live) }
    }

    pub fn cgnat(&self, id: Uuid, minutes: u32) -> Series<CgnatSample> {
        let routers = self.shared.routers.lock().unwrap();
        let data = routers.get(&id);
        let samples: Vec<CgnatSample> = data.map(|d| window(&d.cgnat, minutes).copied().collect()).unwrap_or_default();
        let (step, samples) = downsample(samples, |c| CgnatSample {
            timestamp: c.last().unwrap().timestamp,
            subscribers: avg(c.iter().map(|s| s.subscribers)),
            ports_in_use: avg(c.iter().map(|s| s.ports_in_use)),
            sessions: avg(c.iter().map(|s| s.sessions)),
            refusals: c.last().unwrap().refusals,
        });
        Series { step_seconds: step, samples, live: data.is_some_and(|d| d.live) }
    }

    pub fn pending(&self, id: Uuid) -> Option<PendingConfirm> {
        self.shared.routers.lock().unwrap().get(&id).and_then(|d| d.pending.clone())
    }

    pub fn set_pending(&self, id: Uuid, p: Option<PendingConfirm>) {
        self.shared.routers.lock().unwrap().entry(id).or_default().pending = p;
    }

    /// Marks that the web UI has just changed the router (to ignore the echo).
    pub fn web_action(&self, id: Uuid) {
        self.shared.routers.lock().unwrap().entry(id).or_default().web_action_at = Some(Instant::now());
    }
}

trait Stamped {
    fn at(&self) -> DateTime<Utc>;
}
impl Stamped for RateSample {
    fn at(&self) -> DateTime<Utc> {
        self.timestamp
    }
}
impl Stamped for CgnatSample {
    fn at(&self) -> DateTime<Utc> {
        self.timestamp
    }
}

fn window<T: Stamped>(q: &VecDeque<T>, minutes: u32) -> impl Iterator<Item = &T> {
    let since = Utc::now() - chrono::Duration::minutes(minutes.clamp(1, 24 * 60) as i64);
    q.iter().filter(move |s| s.at() >= since)
}

fn downsample<T>(samples: Vec<T>, merge: impl Fn(&[T]) -> T) -> (u32, Vec<T>) {
    let bucket = samples.len().div_ceil(MAX_POINTS).max(1);
    let step = (bucket as u32) * SAMPLE_MS / 1000;
    (step, samples.chunks(bucket).map(merge).collect())
}

fn avg(it: impl Iterator<Item = u64>) -> u64 {
    let (sum, n) = it.fold((0u128, 0u128), |(s, n), v| (s + v as u128, n + 1));
    if n == 0 { 0 } else { (sum / n) as u64 }
}

fn trim<T: Stamped>(q: &mut VecDeque<T>, now: DateTime<Utc>) {
    let cutoff = now - chrono::Duration::from_std(RETENTION).unwrap();
    while q.front().is_some_and(|s| s.at() < cutoff) {
        q.pop_front();
    }
}

async fn run(h: Arc<RouterHandle>, shared: Arc<Shared>) {
    let mut backoff = Duration::from_secs(2);
    loop {
        let req = SubscribeRequest {
            interval_ms: SAMPLE_MS,
            interface_counters: true,
            interfaces: vec![],
            cgnat_totals: true,
            events: true,
        };
        match h.telemetry().subscribe(req).await {
            Ok(resp) => {
                backoff = Duration::from_secs(2);
                set_live(&shared, h.id, true);
                let mut stream = resp.into_inner();
                loop {
                    match stream.message().await {
                        Ok(Some(update)) => handle(&shared, &h, update).await,
                        Ok(None) => break,
                        Err(e) => {
                            tracing::debug!(router = %h.name, error = %e, "telemetry stream dropped");
                            break;
                        }
                    }
                }
            }
            Err(e) => tracing::debug!(router = %h.name, error = %e, "failed to subscribe to telemetry"),
        }
        set_live(&shared, h.id, false);
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

fn set_live(shared: &Shared, id: Uuid, live: bool) {
    let mut routers = shared.routers.lock().unwrap();
    let d = routers.entry(id).or_default();
    d.live = live;
    if !live {
        // Without the last sample, the next connection does not compute a false
        // rate from the difference accumulated during the outage.
        d.last.clear();
    }
}

async fn handle(shared: &Shared, h: &RouterHandle, u: TelemetryUpdate) {
    let at = u
        .at
        .and_then(|t| DateTime::from_timestamp(t.seconds, t.nanos.max(0) as u32))
        .unwrap_or_else(Utc::now);
    match u.update {
        Some(Update::Interfaces(batch)) => {
            let mut routers = shared.routers.lock().unwrap();
            apply_counters(routers.entry(h.id).or_default(), at, batch.samples);
        }
        Some(Update::Cgnat(c)) => {
            let mut routers = shared.routers.lock().unwrap();
            let d = routers.entry(h.id).or_default();
            d.cgnat.push_back(CgnatSample {
                timestamp: at,
                subscribers: c.subscribers,
                ports_in_use: c.ports_in_use,
                sessions: c.sessions,
                refusals: c.refusals,
            });
            trim(&mut d.cgnat, at);
        }
        Some(Update::Event(e)) => on_event(shared, h, e).await,
        None => {}
    }
}

/// Converts absolute counters into rates (bps) from the difference with the previous sample.
fn apply_counters(d: &mut RouterData, at: DateTime<Utc>, samples: Vec<prisma_proto::v1::InterfaceSample>) {
    for s in samples {
        let Some(c) = s.counters else { continue };
        if let Some((t0, rx0, tx0)) = d.last.insert(s.name.clone(), (at, c.rx_bytes, c.tx_bytes)) {
            let dt = (at - t0).num_milliseconds() as f64 / 1000.0;
            // A counter reset (reboot, clear counters) becomes neither a spike nor a negative rate.
            if dt > 0.0 && c.rx_bytes >= rx0 && c.tx_bytes >= tx0 {
                let q = d.ifaces.entry(s.name).or_default();
                q.push_back(RateSample {
                    timestamp: at,
                    rx_bps: ((c.rx_bytes - rx0) as f64 * 8.0 / dt) as u64,
                    tx_bps: ((c.tx_bytes - tx0) as f64 * 8.0 / dt) as u64,
                });
                trim(q, at);
            }
        }
    }
}

async fn on_event(shared: &Shared, h: &RouterHandle, e: Event) {
    let echo = {
        let mut routers = shared.routers.lock().unwrap();
        let d = routers.entry(h.id).or_default();
        match e.kind.as_str() {
            "confirmed" | "rolled-back" => d.pending = None,
            "confirm-pending" if d.pending.is_none() => {
                d.pending = Some(PendingConfirm { deadline: None, by: e.account.clone(), user_id: None, revision: None })
            }
            _ => {}
        }
        d.web_action_at.is_some_and(|t| t.elapsed() < ECHO_WINDOW)
    };
    // An automatic rollback always goes to the log: nobody asked for it through the web UI.
    if echo && e.kind != "rolled-back" {
        return;
    }
    let action = format!("box.{}", e.kind);
    let username = format!("{} (on the box)", if e.account.is_empty() { "?" } else { &e.account });
    let mut entry = Entry::system(&action, Some(&h.name)).router(h.id).details(json!({ "text": e.text, "account": e.account }));
    entry.username = Some(&username);
    audit::record(&shared.db, entry).await;
}

#[cfg(test)]
mod tests {
    use prisma_proto::v1::{InterfaceCounters, InterfaceSample};

    use super::*;

    fn sample(name: &str, rx: u64, tx: u64) -> InterfaceSample {
        InterfaceSample {
            name: name.into(),
            counters: Some(InterfaceCounters { rx_bytes: rx, tx_bytes: tx, ..Default::default() }),
        }
    }

    fn at(secs: i64) -> DateTime<Utc> {
        Utc::now() - chrono::Duration::seconds(100) + chrono::Duration::seconds(secs)
    }

    #[test]
    fn first_sample_has_no_rate_then_rate_is_delta_in_bits() {
        let mut d = RouterData::default();
        apply_counters(&mut d, at(0), vec![sample("wan0", 1_000, 500)]);
        assert!(d.ifaces.get("wan0").is_none(), "no previous sample, no rate");
        // 5 s later: +6_250_000 bytes rx = 10 Mbps; +625_000 tx = 1 Mbps.
        apply_counters(&mut d, at(5), vec![sample("wan0", 6_251_000, 625_500)]);
        let s = d.ifaces["wan0"].back().unwrap();
        assert_eq!((s.rx_bps, s.tx_bps), (10_000_000, 1_000_000));
    }

    #[test]
    fn counter_reset_produces_no_sample() {
        let mut d = RouterData::default();
        apply_counters(&mut d, at(0), vec![sample("wan0", 9_000_000, 9_000_000)]);
        apply_counters(&mut d, at(5), vec![sample("wan0", 100, 100)]);
        assert!(d.ifaces.get("wan0").is_none(), "a counter reset must not produce a rate");
        // The post-reset sample becomes the new baseline.
        apply_counters(&mut d, at(10), vec![sample("wan0", 625_100, 100)]);
        assert_eq!(d.ifaces["wan0"].back().unwrap().rx_bps, 1_000_000);
    }

    #[test]
    fn downsample_caps_points_and_reports_step() {
        let v: Vec<u64> = (0..1000).collect();
        let (step, out) = downsample(v, |c| c[0]);
        assert!(out.len() <= MAX_POINTS);
        assert_eq!(step, 6 * SAMPLE_MS / 1000);
    }
}
