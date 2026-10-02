//! The CGNAT log export (Prisma 0.149.15, #555): `GetLogging`'s state, the
//! `prisma.v1.LogExport` health name and the `log-*` events. With
//! `MOCK_LOG_EXPORT=1` all three streams are configured and carried by the log
//! container; without it none is, like a box with no log export (the lab box).

use std::time::Instant;

use chrono::{DateTime, Utc};
use prisma_proto::v1::{LogStream, LoggingState};

use crate::state::timestamp;

/// The spill file's cap the box reports (256 MiB).
const SPILL_CAP: u64 = 256 << 20;

pub struct LogSim {
    pub configured: bool,
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
    pub fn new(configured: bool) -> Self {
        Self {
            configured,
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
    pub fn step(&mut self, at: DateTime<Utc>, events: u64) {
        if !self.configured {
            return;
        }
        let bytes = events * 180;
        if self.stalled {
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
        self.tcp_records += events;
        self.tcp_bytes += events * 64;
        self.udp_records += events;
        self.udp_packets += events.div_ceil(20);
    }

    pub fn state(&self, at: DateTime<Utc>) -> LoggingState {
        let streams = if self.configured {
            vec![
                LogStream {
                    kind: "syslog".into(),
                    configured: true,
                    collector: "192.0.2.50:601".into(),
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
                LogStream {
                    kind: "ipfix-tcp".into(),
                    configured: true,
                    collector: "192.0.2.51:4739".into(),
                    carrier: "log-container".into(),
                    connection: "connected".into(),
                    records: self.tcp_records,
                    bytes_sent: self.tcp_bytes,
                    spill_cap_bytes: SPILL_CAP,
                    delivering: true,
                    last_progress: Some(timestamp(at)),
                    ..Default::default()
                },
                LogStream {
                    kind: "ipfix-udp".into(),
                    configured: true,
                    collector: "192.0.2.52:4739".into(),
                    source: "203.0.113.10".into(),
                    carrier: "log-container".into(),
                    records: self.udp_records,
                    packets_sent: self.udp_packets,
                    delivering: true,
                    last_progress: Some(timestamp(at)),
                    ..Default::default()
                },
            ]
        } else {
            ["syslog", "ipfix-tcp", "ipfix-udp"].iter().map(|k| LogStream { kind: (*k).into(), ..Default::default() }).collect()
        };
        LoggingState {
            at: Some(timestamp(at)),
            streams,
            carrier: "log-container".into(),
            logger_pid: if self.configured { self.pid } else { 0 },
            export_ring_dropped: 0,
            worker_queue_dropped: 0,
            exhaustion_repeats_not_reported: if self.configured { self.udp_records / 50 } else { 0 },
            transmit_failed: 0,
            transmit_interface: if self.configured { "wan0".into() } else { String::new() },
            rings_shared: true,
            text: self.text(),
            ..Default::default()
        }
    }

    fn text(&self) -> String {
        if !self.configured {
            return "CGNAT logging\n  syslog      not configured\n  ipfix tcp   not configured\n  ipfix udp   not configured\n  rings       shared segment /dev/shm/prisma-bpa-log\n".into();
        }
        format!(
            "CGNAT logging\n  TCP streams carried by the log container (pid {})\n  syslog      192.0.2.50:601 {} records {}\n  ipfix tcp   192.0.2.51:4739 connected records {}\n  ipfix udp   192.0.2.52:4739\n    sender      the log container: {} records, {} packets, 0 templates, 0 send failures, 0 dropped\n  rings       shared segment /dev/shm/prisma-bpa-log\n",
            self.pid,
            if self.stalled { "disconnected" } else { "connected" },
            self.syslog_records,
            self.tcp_records,
            self.udp_records,
            self.udp_packets
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unconfigured_is_three_empty_streams_and_a_stall_stops_delivery() {
        let off = LogSim::new(false).state(Utc::now());
        assert_eq!(off.streams.iter().map(|s| s.kind.as_str()).collect::<Vec<_>>(), ["syslog", "ipfix-tcp", "ipfix-udp"]);
        assert!(off.streams.iter().all(|s| !s.configured && s.records == 0 && s.collector.is_empty()));

        let mut on = LogSim::new(true);
        on.step(Utc::now(), 100);
        assert!(on.state(Utc::now()).streams.iter().all(|s| s.configured && s.delivering && s.records > 0));
        on.stalled = true;
        for _ in 0..30 {
            on.step(Utc::now(), 1000);
        }
        let s = &on.state(Utc::now()).streams[0];
        assert!(!s.delivering && s.connection == "disconnected" && s.pending_bytes > 0 && !s.stalled_reason.is_empty());
    }
}
