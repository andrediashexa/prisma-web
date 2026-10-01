//! Shared mock state: configuration, revisions, candidates and the
//! traffic counter simulation.

use std::collections::{HashMap, VecDeque};
use std::f64::consts::TAU;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::{DateTime, Utc};
use prisma_proto::v1::{CgnatTotals, Event, HistorySample, InterfaceCounters, InterfaceSample};
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
    /// Last call that named it: the box closes a candidate idle for 30 minutes.
    pub touched: Instant,
}

/// `commit confirmed` awaiting `Confirm`.
pub struct Pending {
    pub token: u64,
    pub deadline: DateTime<Utc>,
    pub previous: Config,
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
    pub pending: Option<Pending>,
    pub next_token: u64,
    pub sims: Vec<IfaceSim>,
    pub mem_used: u64,
    pub subscribers: f64,
    pub refusals: u64,
    /// One sample a minute for the last 24 hours, oldest first (GetHistory).
    pub history: VecDeque<HistorySample>,
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
        let running = Config::seed(hostname);
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
        for s in ["prisma.v1.ConfigService", "prisma.v1.RouteService", "prisma.v1.SessionService"] {
            self.health.set_service_status(s, Serving).await;
        }
        for s in STATS_SERVICES {
            self.health.set_service_status(s, if stats_segment { Serving } else { NotServing }).await;
        }
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
