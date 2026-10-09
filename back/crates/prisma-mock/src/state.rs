//! Shared mock state: configuration, revisions, candidates and the
//! traffic counter simulation.

use std::collections::{HashMap, VecDeque};
use std::f64::consts::TAU;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::{DateTime, Utc};
use prisma_proto::v1::{CgnatTotals, Event, HistorySample, InterfaceCounters, InterfaceSample, UpgradeProgress};
use rand::Rng;
use tokio::sync::broadcast;

use crate::config::Config;

pub struct Revision {
    pub number: u64,
    pub committed_at: DateTime<Utc>,
    pub comment: String,
    pub config: Config,
}

pub struct Candidate {
    pub base_revision: u64,
    pub config: Config,
    pub created: DateTime<Utc>,
    /// Last call that named it: the box closes a candidate idle for 30 minutes.
    pub touched: Instant,
}

/// `commit confirmed` awaiting `Confirm`.
pub struct Pending {
    pub token: u64,
    pub deadline: DateTime<Utc>,
    pub previous: Config,
    /// What GetPendingConfirm reports (Prisma 0.149.18).
    pub revision: String,
    pub account: String,
    pub comment: String,
    pub committed_at: DateTime<Utc>,
    pub minutes: u32,
}

pub struct IfaceSim {
    pub name: String,
    pub mac: Option<String>,
    /// Traffic peak in bits/s for the synthetic curve.
    pub peak_bps: f64,
    /// Slowly changing variation factors, so the curve looks like real traffic.
    pub drift: (f64, f64),
    pub counters: InterfaceCounters,
}

pub struct State {
    pub started: Instant,
    pub running: Config,
    /// Revisions in commit order; the last one is the current one.
    pub revisions: Vec<Revision>,
    pub candidates: HashMap<String, Candidate>,
    /// Candidates closed for idleness, so a later call says so (REASON_CANDIDATE_EXPIRED).
    pub expired: std::collections::HashSet<String>,
    pub pending: Option<Pending>,
    pub next_token: u64,
    pub sims: Vec<IfaceSim>,
    pub mem_used: u64,
    pub subscribers: f64,
    pub refusals: u64,
    /// One sample a minute for the last 24 hours, oldest first (GetHistory).
    pub history: VecDeque<HistorySample>,
    /// The CGNAT log export (GetLogging, Prisma 0.149.15).
    pub logs: crate::log_export::LogSim,
    /// When (in uptime seconds) a BGP session restarted after a hard `Clear` (#48).
    pub bgp_reset: HashMap<String, u64>,
    /// The revision `Save` last wrote: the next boot loads it (REASON_UNSAVED, #50).
    pub saved_revision: u64,
    /// The last upgrade run (GetUpgradeStatus, #50).
    pub upgrade: Option<UpgradeProgress>,
    /// Test hook: how the next dataplane restart answers: `drops` the connection (#51) or
    /// `apply-failed` though it ran (0.149.32, #57); `None` answers as it should.
    pub restart_answer: Option<String>,
    /// Test hook: BFD peers held down (#66).
    pub bfd_down: std::collections::HashSet<String>,
    /// Whether the mock "booted" with third-party SFP+ modules allowed (0.151.2, #69): what the
    /// configuration said at its last simulated reboot.
    pub unsupported_sfp_booted: bool,
    /// What the "boot" left out (0.151.5, #70), set by a test hook.
    pub boot_pending: Option<prisma_proto::v1::PendingConfiguration>,
    /// `show log` (0.151.14, #75): the box's record, oldest first.
    pub box_log: Vec<prisma_proto::v1::BoxEvent>,
    /// The dataplane's last start when it is not the boot's: when, and the cause recorded.
    pub dataplane_start: Option<(DateTime<Utc>, String)>,
    /// wan0's RX power in mW (0.151.15, #76), moved by a test hook.
    pub wan0_rx_mw: f64,
    /// The dataplane still runs the plugin from before the upgrade (0.151.16, #77).
    pub old_plugin: bool,
    /// Test hook (#84): the next commit takes this long, as one waiting for zebra (0.152.7).
    pub commit_delay_secs: u64,
}

/// Samples GetHistory keeps: 24 hours at one a minute.
pub const HISTORY_LEN: usize = 24 * 60;

pub struct Shared {
    pub state: Mutex<State>,
    pub events: broadcast::Sender<Event>,
    /// The account's operational process on Prisma 0.148.4/0.148.5: serves one
    /// call at a time, `Show` included (prisma-web issue #14).
    pub ops: tokio::sync::Mutex<()>,
    /// grpc.health.v1 statuses, as the box reports them.
    pub health: tonic_health::server::HealthReporter,
}

pub type SharedRef = Arc<Shared>;

impl State {
    pub fn new(hostname: &str, scale: f64) -> Self {
        let mut st = Self::empty(hostname, scale);
        st.seed_history(Utc::now());
        st
    }

    fn empty(hostname: &str, scale: f64) -> Self {
        let mut running = Config::seed(hostname);
        if std::env::var("MOCK_LOG_EXPORT").is_ok_and(|v| v == "1") {
            let path = crate::config::CGNAT_PATH.map(String::from);
            running.edit(&path, &crate::config::SEED_LOGGING.map(String::from)).ok().expect("seed logging lines");
        }
        let sim = |name: &str, mac: Option<&str>, peak: f64| {
            let peak = peak * scale;
            // Counters start as if the box had been up for 3 days.
            let base = (peak * 0.5 * 3.0 * 86_400.0 / 8.0) as u64;
            IfaceSim {
                name: name.into(),
                mac: mac.map(Into::into),
                peak_bps: peak,
                drift: (1.0, 1.0),
                counters: InterfaceCounters {
                    rx_bytes: base,
                    tx_bytes: base / 4,
                    rx_packets: base / 900,
                    tx_packets: base / 4 / 600,
                    ..Default::default()
                },
            }
        };
        Self {
            started: Instant::now(),
            revisions: vec![Revision {
                number: 1,
                committed_at: Utc::now() - chrono::Duration::days(3),
                comment: "loaded from file".into(),
                config: running.clone(),
            }],
            running,
            candidates: HashMap::new(),
            expired: std::collections::HashSet::new(),
            pending: None,
            next_token: 1,
            sims: vec![
                sim("wan0", Some("52:54:00:a1:00:01"), 850e6),
                sim("lan0", Some("52:54:00:a1:00:02"), 600e6),
                sim("lan0.20", Some("52:54:00:a1:00:02"), 120e6),
                sim("wg0", None, 60e6),
                sim("lo", None, 1e5),
            ],
            mem_used: 9_400 << 20,
            subscribers: 5_500.0 * scale,
            refusals: 0,
            history: VecDeque::new(),
            logs: crate::log_export::LogSim::new(),
            bgp_reset: HashMap::new(),
            saved_revision: 1,
            upgrade: None,
            restart_answer: None,
            bfd_down: std::collections::HashSet::new(),
            unsupported_sfp_booted: false,
            boot_pending: None,
            box_log: vec![],
            dataplane_start: None,
            wan0_rx_mw: 0.48,
            old_plugin: false,
            commit_delay_secs: 0,
        }
    }

    /// Fills the last 24 hours of history as if the box had been sampling
    /// them, so a client restarted against a fresh mock still has a past.
    fn seed_history(&mut self, now: DateTime<Utc>) {
        for m in (1..=HISTORY_LEN as i64).rev() {
            let at = now - chrono::Duration::minutes(m);
            self.step(at, 60);
            self.record_history(at);
        }
    }

    /// Appends the current counters as a history sample.
    pub fn record_history(&mut self, at: DateTime<Utc>) {
        self.history.push_back(HistorySample {
            at: Some(timestamp(at)),
            interfaces: self
                .sims
                .iter()
                .map(|s| InterfaceSample { name: s.name.clone(), counters: Some(s.counters), ..Default::default() })
                .collect(),
            cgnat: Some(self.cgnat_totals()),
            memory_used_bytes: self.mem_used,
            // Each worker's and each CPU's load at the time (#87).
            workers: crate::cpus::worker_load(at),
            cpus: crate::cpus::usage(at),
            ..Default::default()
        });
        while self.history.len() > HISTORY_LEN {
            self.history.pop_front();
        }
    }

    pub fn cgnat_totals(&self) -> CgnatTotals {
        let subscribers = self.subscribers as u64;
        CgnatTotals { subscribers, ports_in_use: subscribers * 180, sessions: subscribers * 35, refusals: self.refusals, ..Default::default() }
    }

    pub fn revision(&self) -> u64 {
        self.revisions.last().map_or(0, |r| r.number)
    }

    /// Records an event in `show log` (0.151.14, #75), on a box that keeps one.
    #[allow(clippy::too_many_arguments)]
    pub fn record(&mut self, severity: &str, source: &str, kind: &str, text: String, account: &str, origin: &str, start: Option<(&str, &str)>) {
        if !crate::box_log::recorded() {
            return;
        }
        self.seed_log();
        self.box_log.push(crate::box_log::event(Utc::now(), severity, source, kind, text, account, origin, start));
    }

    /// The record opens with the boot and the starts it brought about.
    pub fn seed_log(&mut self) {
        if self.box_log.is_empty() {
            let boot = Utc::now() - chrono::Duration::seconds(self.uptime_seconds() as i64);
            self.box_log = crate::box_log::seed(boot);
        }
    }

    /// Records what the box saw happen (0.152.0, #78), on a box that records it.
    pub fn saw(&mut self, severity: &str, source: &str, kind: &str, subject: &str, reason: &str, text: String) {
        if !crate::box_log::seen() {
            return;
        }
        self.seed_log();
        self.box_log.push(crate::box_log::happened(Utc::now(), severity, source, kind, subject, reason, text));
    }

    /// The dataplane started now, for `cause` ("" when the start is not recorded).
    pub fn dataplane_started_now(&mut self, cause: &str, account: &str) {
        self.dataplane_start = Some((Utc::now(), cause.to_string()));
        if !cause.is_empty() {
            self.record(if cause == "unexpected" { "warning" } else { "info" }, "dataplane", "start", format!("the dataplane started ({cause})"), account, "the box", Some(("dataplane", cause)));
        }
    }

    pub fn uptime_seconds(&self) -> u64 {
        // Pretends the box has been up for 3 days.
        self.started.elapsed().as_secs() + 3 * 86_400 + 7_342
    }

    /// Revision by its `rollback` number (0 is the newest).
    pub fn by_rollback_number(&self, n: u32) -> Option<&Revision> {
        let len = self.revisions.len();
        (n as usize).lt(&len).then(|| &self.revisions[len - 1 - n as usize])
    }

    pub fn push_revision(&mut self, comment: String) -> u64 {
        let number = self.revision() + 1;
        self.revisions.push(Revision {
            number,
            committed_at: Utc::now(),
            comment,
            config: self.running.clone(),
        });
        number
    }

    /// The candidate, touched; `None` if it does not exist or sat idle longer
    /// than the box allows (then it is closed, as the box does).
    pub fn candidate(&mut self, id: &str) -> Option<&mut Candidate> {
        let idle = candidate_idle();
        if self.candidates.get(id).is_some_and(|c| c.touched.elapsed() > idle) {
            self.candidates.remove(id);
            self.expired.insert(id.to_string());
        }
        let c = self.candidates.get_mut(id)?;
        c.touched = Instant::now();
        Some(c)
    }

    pub fn sim(&self, name: &str) -> Option<&IfaceSim> {
        self.sims.iter().find(|s| s.name == name)
    }

    /// Advances the simulation by `secs` seconds.
    pub fn step(&mut self, at: DateTime<Utc>, secs: u64) {
        let mut rng = rand::thread_rng();
        // Daily curve peaking at 21:00 local time (UTC-3).
        let hour = ((at.timestamp() as f64 / 3600.0) - 3.0).rem_euclid(24.0);
        let daily = 0.55 + 0.45 * ((hour - 21.0) / 24.0 * TAU).cos();

        for sim in &mut self.sims {
            let walk = |v: f64, rng: &mut rand::rngs::ThreadRng| (v + rng.gen_range(-0.02..0.02)).clamp(0.7, 1.2);
            sim.drift = (walk(sim.drift.0, &mut rng), walk(sim.drift.1, &mut rng));
            let up = self.running.iface(&sim.name).is_some_and(|i| !i.shutdown);
            if !up {
                continue;
            }
            let jitter = |rng: &mut rand::rngs::ThreadRng| rng.gen_range(0.97..1.03);
            let rx = sim.peak_bps * daily * sim.drift.0 * jitter(&mut rng);
            // Download dominates; upload is ~25% of download.
            let tx = sim.peak_bps * daily * 0.25 * sim.drift.1 * jitter(&mut rng);

            let c = &mut sim.counters;
            let rx_bytes = (rx / 8.0) as u64 * secs;
            let tx_bytes = (tx / 8.0) as u64 * secs;
            c.rx_bytes += rx_bytes;
            c.tx_bytes += tx_bytes;
            c.rx_packets += rx_bytes / 900;
            c.tx_packets += tx_bytes / 600;
            if rng.gen_ratio(1, 4000) {
                c.rx_errors += 1;
            }
            if rng.gen_ratio(1, 300) {
                c.drops += rng.gen_range(1..20);
            }
        }

        let jitter: i64 = rng.gen_range(-4..=4) * 1024 * 1024;
        self.mem_used = (self.mem_used as i64 + jitter).clamp(9_000 << 20, 10_200 << 20) as u64;
        let target = 5_500.0 * daily.max(0.6) / 0.8;
        self.subscribers = (self.subscribers + rng.gen_range(-15.0..15.0) + (target - self.subscribers) * 0.01).max(0.0);
        if rng.gen_ratio(1, 50) {
            self.refusals += 1;
        }
        // About one block event a second per 50 subscribers.
        let events = (self.subscribers / 50.0) as u64 * secs;
        let collectors = self.running.log_collectors();
        self.logs.step(at, events, &collectors);
    }
}

/// Services the box reports NOT_SERVING while the dataplane's statistics
/// segment does not answer (docs/prisma-api.md).
const STATS_SERVICES: [&str; 2] = ["prisma.v1.OperationalService", "prisma.v1.TelemetryService"];

impl Shared {
    /// Health of every prisma.v1 service; `stats_segment` false is the
    /// box's state while the dataplane's statistics do not answer.
    pub async fn set_health(&self, stats_segment: bool) {
        use tonic_health::ServingStatus::{NotServing, Serving};
        for s in ["prisma.v1.ConfigService", "prisma.v1.RouteService", "prisma.v1.SessionService", "prisma.v1.LogExport"] {
            self.health.set_service_status(s, Serving).await;
        }
        // SystemService came with Clear in 0.149.25; the line-only mock is an older box (#48).
        if !crate::typed::disabled() {
            self.health.set_service_status("prisma.v1.SystemService", Serving).await;
            // NOT_SERVING exactly while part of the configuration is pending (0.151.5, #70).
            self.health.set_service_status("prisma.v1.Configuration", Serving).await;
        }
        for s in STATS_SERVICES {
            self.health.set_service_status(s, if stats_segment { Serving } else { NotServing }).await;
        }
    }

    /// Part of the configuration pending, or not (#70): the state and `prisma.v1.Configuration`'s health.
    pub async fn set_pending(&self, pending: Option<prisma_proto::v1::PendingConfiguration>) {
        use tonic_health::ServingStatus::{NotServing, Serving};
        let on = pending.is_some();
        self.state.lock().unwrap().boot_pending = pending;
        self.health.set_service_status("prisma.v1.Configuration", if on { NotServing } else { Serving }).await;
    }

    /// The log export stalls or delivers again (test hook): health and event as the box gives them.
    pub async fn set_log_stalled(&self, stalled: bool) {
        use tonic_health::ServingStatus::{NotServing, Serving};
        {
            let mut st = self.state.lock().unwrap();
            st.logs.stalled = stalled;
            st.logs.stalled_since = stalled.then(std::time::Instant::now);
        }
        self.health.set_service_status("prisma.v1.LogExport", if stalled { NotServing } else { Serving }).await;
        let collector = self.state.lock().unwrap().running.log_collectors().syslog.map(|c| c.endpoint()).unwrap_or_default();
        let (kind, text) = if stalled {
            ("log-stalled", format!("syslog {collector}: bytes waiting and nothing sent for 60 s"))
        } else {
            ("log-delivering", format!("syslog {collector}: delivering again"))
        };
        self.emit(kind, &text);
    }

    pub fn emit(&self, kind: &str, text: impl Into<String>) {
        self.emit_full(kind, text.into(), String::new(), String::new());
    }

    /// A commit event carries the revision and the comment (Prisma 0.149.2).
    pub fn emit_commit(&self, revision: String, comment: String) {
        self.emit_full("commit", comment.clone(), revision, comment);
    }

    fn emit_full(&self, kind: &str, text: String, revision: String, comment: String) {
        // With no subscribers the send fails; that is expected.
        let _ = self.events.send(Event { kind: kind.into(), account: "mock".into(), text, revision, comment, ..Default::default() });
    }
}

/// Idle limit of a candidate: 30 minutes on the box; `MOCK_CANDIDATE_IDLE_SECS`
/// shortens it so e2e can see one expire (#11).
pub fn candidate_idle() -> std::time::Duration {
    let secs = std::env::var("MOCK_CANDIDATE_IDLE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(30 * 60);
    std::time::Duration::from_secs(secs)
}

pub fn timestamp(at: DateTime<Utc>) -> prost_types::Timestamp {
    prost_types::Timestamp { seconds: at.timestamp(), nanos: at.timestamp_subsec_nanos() as i32 }
}
