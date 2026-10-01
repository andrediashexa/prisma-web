//! Shared mock state: configuration, revisions, candidates and the
//! traffic counter simulation.

use std::collections::HashMap;
use std::f64::consts::TAU;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::{DateTime, Utc};
use prisma_proto::v1::{Event, InterfaceCounters};
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
}

pub struct Shared {
    pub state: Mutex<State>,
    pub events: broadcast::Sender<Event>,
    /// The account's operational process on Prisma 0.148.4/0.148.5: serves one
    /// call at a time, `Show` included (prisma-web issue #14).
    pub ops: tokio::sync::Mutex<()>,
}

pub type SharedRef = Arc<Shared>;

impl State {
    pub fn new(hostname: &str, scale: f64) -> Self {
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
        }
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

impl Shared {
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

pub fn timestamp(at: DateTime<Utc>) -> prost_types::Timestamp {
    prost_types::Timestamp { seconds: at.timestamp(), nanos: at.timestamp_subsec_nanos() as i32 }
}
