//! The CGNAT log export (Prisma 0.149.15, #555): `GetLogging`'s state, the
//! `prisma.v1.LogExport` health name and the `log-*` events. The streams are
//! the collectors the running configuration's `logging` lines set (#41):
//! `MOCK_LOG_EXPORT=1` seeds all three, carried by the log container; without
//! it none is configured, like a box with no log export (the lab box).

use std::time::Instant;

use chrono::{DateTime, Utc};
use prisma_proto::v1::{LogStream, LoggingState};

use crate::config::Collectors;
use crate::state::timestamp;

/// The spill file's cap the box reports (256 MiB).
const SPILL_CAP: u64 = 256 << 20;

pub struct LogSim {
    /// Test hook: the syslog collector stopped taking anything.
    pub stalled: bool,
    pub stalled_since: Option<Instant>,
    syslog_records: u64,
    syslog_bytes: u64,
    syslog_pending: u64,
    syslog_spill: u64,
    syslog_progress: DateTime<Utc>,
    tcp_records: u64,
    tcp_bytes: u64,
    udp_records: u64,
    udp_packets: u64,
    pid: u32,
}

impl LogSim {
    pub fn new() -> Self {
        Self {
            stalled: false,
            stalled_since: None,
            syslog_records: 0,
            syslog_bytes: 0,
            syslog_pending: 0,
            syslog_spill: 0,
            syslog_progress: Utc::now(),
            tcp_records: 0,
            tcp_bytes: 0,
            udp_records: 0,
            udp_packets: 0,
            pid: 4242,
        }
    }

    /// One second of export, `events` block events at the subscribers' pace.
    pub fn step(&mut self, at: DateTime<Utc>, events: u64, to: &Collectors) {
        let bytes = events * 180;
        if to.syslog.is_none() {
            // Nothing to send to: a stall has no backlog to build.
        } else if self.stalled {
            // Nothing leaves: memory fills first, then the spill file.
            self.syslog_pending = (self.syslog_pending + bytes).min(4 << 20);
            if self.syslog_pending >= 4 << 20 {
                self.syslog_spill = (self.syslog_spill + bytes).min(SPILL_CAP);
            }
        } else {
            self.syslog_records += events;
            self.syslog_bytes += bytes + self.syslog_pending + self.syslog_spill;
            self.syslog_pending = 0;
            self.syslog_spill = 0;
            self.syslog_progress = at;
        }
        if to.tcp.is_some() {
            self.tcp_records += events;
            self.tcp_bytes += events * 64;
        }
        if to.udp.is_some() {
            self.udp_records += events;
            self.udp_packets += events.div_ceil(20);
        }
    }

    pub fn state(&self, at: DateTime<Utc>, to: &Collectors) -> LoggingState {
        let off = |kind: &str| LogStream { kind: kind.into(), ..Default::default() };
        let syslog = to.syslog.as_ref().map_or_else(
            || off("syslog"),
            |c| LogStream {
                kind: "syslog".into(),
                configured: true,
                collector: c.endpoint(),
                carrier: "log-container".into(),
                connection: if self.stalled { "disconnected".into() } else { "connected".into() },
                records: self.syslog_records,
                bytes_sent: self.syslog_bytes,
                pending_bytes: self.syslog_pending,
                spill_bytes: self.syslog_spill,
                spill_cap_bytes: SPILL_CAP,
                delivering: !self.stalled,
                stalled_reason: if self.stalled {
                    "bytes waiting and nothing sent for 60 s: the collector does not take them".into()
                } else {
                    String::new()
                },
                last_progress: Some(timestamp(self.syslog_progress)),
                ..Default::default()
            },
        );
        let tcp = to.tcp.as_ref().map_or_else(
            || off("ipfix-tcp"),
            |c| LogStream {
                kind: "ipfix-tcp".into(),
                configured: true,
                collector: c.endpoint(),
                carrier: "log-container".into(),
                connection: "connected".into(),
                records: self.tcp_records,
                bytes_sent: self.tcp_bytes,
                spill_cap_bytes: SPILL_CAP,
                delivering: true,
                last_progress: Some(timestamp(at)),
                ..Default::default()
            },
        );
        let udp = to.udp.as_ref().map_or_else(
            || off("ipfix-udp"),
            |c| LogStream {
                kind: "ipfix-udp".into(),
                configured: true,
                collector: c.endpoint(),
                source: c.source.clone(),
                carrier: "log-container".into(),
                records: self.udp_records,
                packets_sent: self.udp_packets,
                delivering: true,
                last_progress: Some(timestamp(at)),
                ..Default::default()
            },
        );
        let configured = to.syslog.is_some() || to.tcp.is_some() || to.udp.is_some();
        let text = self.text(&[&syslog, &tcp, &udp]);
        let streams = vec![syslog, tcp, udp];
        LoggingState {
            at: Some(timestamp(at)),
            streams,
            carrier: "log-container".into(),
            logger_pid: if configured { self.pid } else { 0 },
            export_ring_dropped: 0,
            worker_queue_dropped: 0,
            exhaustion_repeats_not_reported: if configured { self.udp_records / 50 } else { 0 },
            transmit_failed: 0,
            transmit_interface: if configured { "wan0".into() } else { String::new() },
            rings_shared: true,
            text,
            ..Default::default()
        }
    }

    /// `show cgnat logging`, one line a stream.
    fn text(&self, streams: &[&LogStream]) -> String {
        let mut out = String::from("CGNAT logging\n");
        if streams.iter().any(|s| s.configured) {
            out += &format!("  TCP streams carried by the log container (pid {})\n", self.pid);
        }
        for s in streams {
            let name = match s.kind.as_str() {
                "ipfix-tcp" => "ipfix tcp",
                "ipfix-udp" => "ipfix udp",
                k => k,
            };
            if !s.configured {
                out += &format!("  {name:<11} not configured\n");
            } else if s.kind == "ipfix-udp" {
                out += &format!(
                    "  {name:<11} {}\n    sender      the log container: {} records, {} packets, 0 templates, 0 send failures, 0 dropped\n",
                    s.collector, s.records, s.packets_sent
                );
            } else {
                out += &format!("  {name:<11} {} {} records {}\n", s.collector, s.connection, s.records);
            }
        }
        out + "  rings       shared segment /dev/shm/prisma-bpa-log\n"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unconfigured_is_three_empty_streams_and_a_stall_stops_delivery() {
        let none = Collectors::default();
        let off = LogSim::new().state(Utc::now(), &none);
        assert_eq!(off.streams.iter().map(|s| s.kind.as_str()).collect::<Vec<_>>(), ["syslog", "ipfix-tcp", "ipfix-udp"]);
        assert!(off.streams.iter().all(|s| !s.configured && s.records == 0 && s.collector.is_empty()));

        let mut c = crate::config::Config::seed("x");
        c.edit(&crate::config::CGNAT_PATH.map(String::from), &crate::config::SEED_LOGGING.map(String::from)).ok().unwrap();
        let all = c.log_collectors();
        let mut on = LogSim::new();
        on.step(Utc::now(), 100, &all);
        let st = on.state(Utc::now(), &all);
        assert!(st.streams.iter().all(|s| s.configured && s.delivering && s.records > 0));
        assert_eq!(st.streams[0].collector, "192.0.2.50:601");
        assert!(st.text.contains("syslog      192.0.2.50:601 connected"), "{}", st.text);
        on.stalled = true;
        for _ in 0..30 {
            on.step(Utc::now(), 1000, &all);
        }
        let s = &on.state(Utc::now(), &all).streams[0];
        assert!(!s.delivering && s.connection == "disconnected" && s.pending_bytes > 0 && !s.stalled_reason.is_empty());

        // Only what the configuration names is configured.
        let tcp_only = Collectors { tcp: all.tcp.clone(), ..Default::default() };
        let st = on.state(Utc::now(), &tcp_only);
        assert_eq!(st.streams.iter().map(|s| s.configured).collect::<Vec<_>>(), [false, true, false]);
    }
}
