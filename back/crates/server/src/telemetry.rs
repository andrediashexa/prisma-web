//! Prisma telemetry: one permanent `Subscribe` per router.
//!
//! Prisma delivers live counters; the history (24 h) is built here, in
//! memory, from the differences between samples. On every connection the gap
//! is first filled from the box's own history (`GetHistory`, one sample a
//! minute), so a restart of this server does not empty the charts (#7).
//! The stream's configuration
//! events (commits made on the box itself, automatic rollbacks of
//! `commit confirmed`) go to the change log.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use prisma_proto::v1::telemetry_update::Update;
use prisma_proto::v1::{Event, GetHistoryRequest, HistorySample, SubscribeRequest, TelemetryUpdate};
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

/// One of the box's CGNAT log export events (`log-*`, Prisma 0.149.15). They
/// are operational, not configuration changes: kept here, not in the change log.
#[derive(Clone, Serialize)]
pub struct LogEvent {
    pub at: DateTime<Utc>,
    pub kind: String,
    pub text: String,
}

/// How many log events are kept per router.
const LOG_EVENTS: usize = 50;

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
    /// Revisions prisma-web committed itself, newest last: their `commit`
    /// events are the echo (Event.revision, Prisma 0.149.2, #30).
    own_revisions: VecDeque<String>,
    log_events: VecDeque<LogEvent>,
}

/// How many of its own revisions are remembered per router.
const OWN_REVISIONS: usize = 32;

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
        let (step, samples) = downsample(samples, minutes, |c| RateSample {
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
        let (step, samples) = downsample(samples, minutes, |c| CgnatSample {
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

    /// Recent log export events, newest first.
    pub fn log_events(&self, id: Uuid) -> Vec<LogEvent> {
        self.shared.routers.lock().unwrap().get(&id).map(|d| d.log_events.iter().rev().cloned().collect()).unwrap_or_default()
    }

    /// Records a revision committed through the web UI, so its `commit` event is not logged twice.
    pub fn own_commit(&self, id: Uuid, revision: &str) {
        let mut routers = self.shared.routers.lock().unwrap();
        let own = &mut routers.entry(id).or_default().own_revisions;
        own.push_back(revision.to_string());
        while own.len() > OWN_REVISIONS {
            own.pop_front();
        }
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

/// At most `MAX_POINTS` buckets of equal duration over the window. By time,
/// not by count: backfilled minutes and live 5 s samples share one series.
fn downsample<T: Stamped>(samples: Vec<T>, minutes: u32, merge: impl Fn(&[T]) -> T) -> (u32, Vec<T>) {
    let window = minutes.clamp(1, 24 * 60) * 60;
    let step = window.div_ceil(MAX_POINTS as u32).max(SAMPLE_MS / 1000);
    let out = samples
        .chunk_by(|a, b| a.at().timestamp().div_euclid(step.into()) == b.at().timestamp().div_euclid(step.into()))
        .map(merge)
        .collect();
    (step, out)
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
            // An older box ignores the field it does not know.
            logging_events: true,
            ..Default::default()
        };
        backfill(&h, &shared).await;
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

/// Fills what this server missed (all of it after a restart, the outage after
/// a reconnection) from the box's history. A box older than 0.149.2 answers
/// UNIMPLEMENTED and the charts just start from the live stream, as before.
async fn backfill(h: &RouterHandle, shared: &Shared) {
    let since = shared.routers.lock().unwrap().get(&h.id).and_then(newest);
    let req = GetHistoryRequest {
        since: since.map(|t| prost_types::Timestamp { seconds: t.timestamp(), nanos: t.timestamp_subsec_nanos() as i32 }),
        interface_counters: true,
        cgnat_totals: true,
        ..Default::default()
    };
    let mut stream = match h.telemetry().get_history(req).await {
        Ok(r) => r.into_inner(),
        Err(e) => {
            tracing::debug!(router = %h.name, error = %e, "no history from the router");
            return;
        }
    };
    let mut samples = Vec::new();
    loop {
        match stream.message().await {
            Ok(Some(s)) => samples.push(s),
            Ok(None) => break,
            // Keep what arrived: a partial history is still better than none.
            Err(e) => {
                tracing::debug!(router = %h.name, error = %e, "history stream dropped");
                break;
            }
        }
    }
    let n = samples.len();
    let mut routers = shared.routers.lock().unwrap();
    apply_history(routers.entry(h.id).or_default(), samples);
    tracing::info!(router = %h.name, samples = n, "telemetry history backfilled");
}

/// The newest sample held for the router; `None` when anything is still empty,
/// so the whole history is asked for.
fn newest(d: &RouterData) -> Option<DateTime<Utc>> {
    let cgnat = d.cgnat.back()?.timestamp;
    d.ifaces.values().map(|q| q.back().map(|s| s.timestamp)).try_fold(cgnat, |m, t| t.map(|t| m.min(t)))
}

/// Merges history samples (oldest first) into the series: rates between
/// consecutive minutes, with the same reset rule as the live stream, and only
/// after what each series already holds.
fn apply_history(d: &mut RouterData, samples: Vec<HistorySample>) {
    let mut last: HashMap<String, (DateTime<Utc>, u64, u64)> = HashMap::new();
    let mut ifaces: HashMap<String, VecDeque<RateSample>> = HashMap::new();
    let mut cgnat = VecDeque::new();
    for s in samples {
        let Some(at) = s.at.and_then(|t| DateTime::from_timestamp(t.seconds, t.nanos.max(0) as u32)) else { continue };
        for i in s.interfaces {
            let Some(c) = i.counters else { continue };
            if let Some((t0, rx0, tx0)) = last.insert(i.name.clone(), (at, c.rx_bytes, c.tx_bytes)) {
                if let Some(r) = rate(at, t0, (c.rx_bytes, c.tx_bytes), (rx0, tx0)) {
                    ifaces.entry(i.name).or_default().push_back(r);
                }
            }
        }
        if let Some(c) = s.cgnat {
            cgnat.push_back(CgnatSample {
                timestamp: at,
                subscribers: c.subscribers,
                ports_in_use: c.ports_in_use,
                sessions: c.sessions,
                refusals: c.refusals,
            });
        }
    }
    let now = Utc::now();
    for (name, new) in ifaces {
        merge(d.ifaces.entry(name).or_default(), new, now);
    }
    merge(&mut d.cgnat, cgnat, now);
}

/// Appends `new` (sorted) after the newest sample of `q`.
fn merge<T: Stamped>(q: &mut VecDeque<T>, new: VecDeque<T>, now: DateTime<Utc>) {
    let after = q.back().map(|s| s.at());
    q.extend(new.into_iter().filter(|s| after.is_none_or(|a| s.at() > a)));
    trim(q, now);
}

/// Rate in bits/s between two counter readings; `None` on a counter reset.
fn rate(at: DateTime<Utc>, t0: DateTime<Utc>, (rx, tx): (u64, u64), (rx0, tx0): (u64, u64)) -> Option<RateSample> {
    let dt = (at - t0).num_milliseconds() as f64 / 1000.0;
    // A counter reset (reboot, clear counters) becomes neither a spike nor a negative rate.
    (dt > 0.0 && rx >= rx0 && tx >= tx0).then(|| RateSample {
        timestamp: at,
        rx_bps: ((rx - rx0) as f64 * 8.0 / dt) as u64,
        tx_bps: ((tx - tx0) as f64 * 8.0 / dt) as u64,
    })
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

async fn handle(shared: &Arc<Shared>, h: &RouterHandle, u: TelemetryUpdate) {
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
        Some(Update::Event(e)) if e.kind.starts_with("log-") => {
            let mut routers = shared.routers.lock().unwrap();
            push_log_event(routers.entry(h.id).or_default(), LogEvent { at, kind: e.kind, text: e.text });
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
            if let Some(r) = rate(at, t0, (c.rx_bytes, c.tx_bytes), (rx0, tx0)) {
                let q = d.ifaces.entry(s.name).or_default();
                q.push_back(r);
                trim(q, at);
            }
        }
    }
}

fn push_log_event(d: &mut RouterData, e: LogEvent) {
    d.log_events.push_back(e);
    while d.log_events.len() > LOG_EVENTS {
        d.log_events.pop_front();
    }
}

#[derive(Debug, PartialEq)]
enum Echo {
    /// The event is the echo of a web action: not logged again.
    Yes,
    /// A change made on the device: logged.
    No,
    /// A commit with a revision not known yet, during a web action: the web
    /// commit may still be returning its revision.
    Wait,
}

/// Whether an event is the echo of prisma-web's own action. A `commit` event is
/// matched by its revision (#30); without one (another commit landed while the
/// box read it) and for the other kinds, by the time window.
fn echo_of(kind: &str, revision: &str, own: &VecDeque<String>, in_window: bool) -> Echo {
    match kind {
        // An automatic rollback always goes to the log: nobody asked for it through the web UI.
        "rolled-back" => Echo::No,
        "commit" if !revision.is_empty() => {
            if own.iter().any(|r| r == revision) {
                Echo::Yes
            } else if in_window {
                Echo::Wait
            } else {
                Echo::No
            }
        }
        _ if in_window => Echo::Yes,
        _ => Echo::No,
    }
}

/// Applies the event to the pending-confirm state and decides whether it is an echo.
fn classify(shared: &Shared, id: Uuid, e: &Event) -> Echo {
    let mut routers = shared.routers.lock().unwrap();
    let d = routers.entry(id).or_default();
    let in_window = d.web_action_at.is_some_and(|t| t.elapsed() < ECHO_WINDOW);
    echo_of(&e.kind, &e.revision, &d.own_revisions, in_window)
}

async fn on_event(shared: &Arc<Shared>, h: &RouterHandle, e: Event) {
    {
        let mut routers = shared.routers.lock().unwrap();
        let d = routers.entry(h.id).or_default();
        match e.kind.as_str() {
            "confirmed" | "rolled-back" => d.pending = None,
            "confirm-pending" if d.pending.is_none() => {
                d.pending = Some(PendingConfirm { deadline: None, by: e.account.clone(), user_id: None, revision: None })
            }
            _ => {}
        }
    }
    match classify(shared, h.id, &e) {
        Echo::Yes => {}
        Echo::No => record_event(shared, h.id, &h.name, e).await,
        Echo::Wait => {
            // Decided off the stream, so the counters keep flowing meanwhile.
            let (shared, id, name) = (shared.clone(), h.id, h.name.clone());
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    match classify(&shared, id, &e) {
                        Echo::Yes => return,
                        Echo::No => return record_event(&shared, id, &name, e).await,
                        Echo::Wait => {}
                    }
                }
            });
        }
    }
}

async fn record_event(shared: &Shared, id: Uuid, router: &str, e: Event) {
    let action = format!("box.{}", e.kind);
    let username = format!("{} (on the device)", if e.account.is_empty() { "?" } else { &e.account });
    let mut details = json!({ "text": e.text, "account": e.account });
    if !e.revision.is_empty() {
        details["revision"] = json!(e.revision);
    }
    let mut entry = Entry::system(&action, Some(router)).router(id).details(details);
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
            ..Default::default()
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

    fn rates(n: i64, every: i64, end: i64) -> Vec<RateSample> {
        (0..n).map(|i| RateSample { timestamp: at(end - (n - 1 - i) * every), rx_bps: 1, tx_bps: 1 }).collect()
    }

    #[test]
    fn log_events_are_kept_apart_and_capped() {
        let mut d = RouterData::default();
        for i in 0..(LOG_EVENTS + 5) {
            push_log_event(&mut d, LogEvent { at: Utc::now(), kind: "log-spill".into(), text: format!("{i}") });
        }
        assert_eq!(d.log_events.len(), LOG_EVENTS);
        assert_eq!(d.log_events.back().unwrap().text, format!("{}", LOG_EVENTS + 4), "the newest kept");
    }

    #[test]
    fn own_commit_is_matched_by_revision_not_by_time() {
        let own: VecDeque<String> = ["r7".to_string()].into();
        assert_eq!(echo_of("commit", "r7", &own, false), Echo::Yes, "our revision, even late");
        assert_eq!(echo_of("commit", "r8", &own, true), Echo::Wait, "unknown yet during a web action");
        assert_eq!(echo_of("commit", "r8", &own, false), Echo::No, "a commit made on the device");
        assert_eq!(echo_of("commit", "", &own, true), Echo::Yes, "no revision: the time window decides");
        assert_eq!(echo_of("commit", "", &own, false), Echo::No);
        assert_eq!(echo_of("rolled-back", "r7", &own, true), Echo::No, "a rollback is always logged");
        assert_eq!(echo_of("confirmed", "r7", &own, true), Echo::Yes);
    }

    #[test]
    fn downsample_caps_points_and_reports_step() {
        // An hour of 5 s samples: 20 s buckets.
        let (step, out) = downsample(rates(720, 5, 0), 60, |c| c[0]);
        assert_eq!(step, 20);
        assert!(out.len() <= MAX_POINTS + 1);
        // 24 h: 8 min buckets, whatever the mix of minutes and 5 s samples.
        let (step, out) = downsample(rates(1440, 60, 0), 24 * 60, |c| c[0]);
        assert_eq!(step, 480);
        assert!(out.len() <= MAX_POINTS + 1);
    }

    fn hist(secs: i64, rx: u64, subscribers: u64) -> HistorySample {
        let t = at(secs);
        HistorySample {
            at: Some(prost_types::Timestamp { seconds: t.timestamp(), nanos: 0 }),
            interfaces: vec![sample("wan0", rx, 0)],
            cgnat: Some(prisma_proto::v1::CgnatTotals { subscribers, ..Default::default() }),
            ..Default::default()
        }
    }

    #[test]
    fn history_backfills_rates_skips_resets_and_never_duplicates() {
        let mut d = RouterData::default();
        // Minutes 0, 1, 2 (reset), 3: +750_000 bytes a minute = 100 kbps.
        apply_history(&mut d, vec![hist(-240, 0, 10), hist(-180, 750_000, 11), hist(-120, 5, 12), hist(-60, 750_005, 13)]);
        let r: Vec<u64> = d.ifaces["wan0"].iter().map(|s| s.rx_bps).collect();
        assert_eq!(r, [100_000, 100_000], "the reset minute produces no rate");
        assert_eq!(d.cgnat.len(), 4);
        // A live sample, then the same history again (a reconnection): nothing older is added twice.
        apply_counters(&mut d, at(-1), vec![sample("wan0", 1, 0)]);
        d.cgnat.push_back(CgnatSample { timestamp: at(-1), subscribers: 14, ports_in_use: 0, sessions: 0, refusals: 0 });
        apply_history(&mut d, vec![hist(-240, 0, 10), hist(-180, 750_000, 11)]);
        assert_eq!((d.ifaces["wan0"].len(), d.cgnat.len()), (2, 5));
        let wan_newest = d.ifaces["wan0"].back().unwrap().timestamp;
        assert_eq!(newest(&d), Some(wan_newest), "the oldest of each series' newest sample");
    }
}
