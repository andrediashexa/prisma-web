//! Each CPU's place and load (Prisma 0.152.9, prismarouting #598, prisma-web #87): the topology
//! and the usage of every logical CPU, as GetSystem and GetHistory answer them. The simulated box
//! has 2 sockets of 4 cores, one thread each, a NUMA node each; the layout is control plane 0-1,
//! the main thread 2, workers 0-4 on 3-7 (`system cpu`).

use chrono::{DateTime, Utc};
use prisma_proto::v1::{CpuSocket, CpuTopology, CpuUsage, LogicalCpu, WorkerLoad};

/// From this release the box reports them.
pub fn reported() -> bool {
    crate::operational::release_at_least((0, 152, 9))
}

const CPUS: i32 = 8;

fn plane(cpu: i32) -> (&'static str, i32) {
    match cpu {
        0 | 1 => ("control-plane", -1),
        2 => ("main", -1),
        c => ("worker", c - 3),
    }
}

pub fn topology() -> CpuTopology {
    CpuTopology {
        model: "Intel(R) Xeon(R) Silver 4314 CPU @ 2.40GHz (simulated)".into(),
        sockets: 2,
        physical_cores: 8,
        threads_per_core: 1,
        numa_nodes: 2,
        logical_cpus: CPUS as u32,
        socket_cores: (0..2).map(|s| CpuSocket { socket: s, physical_cores: 4, logical_cpus: 4 }).collect(),
        cpus: (0..CPUS)
            .map(|c| {
                let (plane, worker) = plane(c);
                LogicalCpu { cpu: c as u32, socket: c / 4, core: c % 4, numa_node: c / 4, siblings: vec![], plane: plane.into(), worker }
            })
            .collect(),
    }
}

/// A smooth daily-ish wave, so a chart of the history has a shape: 0 to 1.
fn wave(at: DateTime<Utc>, phase: f64) -> f64 {
    let t = at.timestamp() as f64 / 3600.0;
    0.5 + 0.5 * (t / 3.0 + phase).sin()
}

/// The workers' load as WorkerLoad reports it, at a time.
pub fn worker_load(at: DateTime<Utc>) -> Vec<WorkerLoad> {
    (0..5u32)
        .map(|w| {
            let base = if w == 4 { 0.40 } else { 0.06 + f64::from(w) * 0.04 };
            let busy = ((base + 0.10 * wave(at, f64::from(w))) * 1000.0).round() / 1000.0;
            WorkerLoad { worker: w, cpu: 3 + w, busy_ratio: busy.min(0.52), busy_window_ms: 60_000, ..Default::default() }
        })
        .collect()
}

/// Every CPU's usage over the minute ending at `at`: a polling worker's CPU reads ~100% busy, its
/// load being its busy_ratio; the control plane and the main thread read their own share.
pub fn usage(at: DateTime<Utc>) -> Vec<CpuUsage> {
    let workers = worker_load(at);
    (0..CPUS)
        .map(|c| {
            let (plane, worker) = plane(c);
            let (busy, polling, ratio) = match plane {
                "control-plane" => (8.0 + 22.0 * wave(at, f64::from(c) * 1.7), false, 0.0),
                "main" => (12.0 + 6.0 * wave(at, 0.5), false, 0.0),
                _ => (99.6, true, workers[worker as usize].busy_ratio),
            };
            CpuUsage {
                cpu: c as u32,
                busy_percent: (busy * 10.0f64).round() / 10.0,
                // A guest's steal, on one control-plane CPU.
                steal_percent: if c == 1 { 0.6 } else { 0.0 },
                polling,
                busy_ratio: ratio,
                window_ms: 60_000,
            }
        })
        .collect()
}

pub fn text() -> String {
    let t = topology();
    let mut out = format!("{}\n{} sockets, {} physical cores, {} thread(s) per core, {} NUMA nodes\n", t.model, t.sockets, t.physical_cores, t.threads_per_core, t.numa_nodes);
    for c in &t.cpus {
        out.push_str(&format!("  cpu {:<2} socket {} core {} numa {}  {}\n", c.cpu, c.socket, c.core, c.numa_node, c.plane));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workers_poll_and_carry_their_busy_ratio() {
        let u = usage(Utc::now());
        assert_eq!(u.len(), 8);
        assert!(u[3..].iter().all(|c| c.polling && c.busy_percent > 99.0 && c.busy_ratio > 0.0));
        assert!(u[..3].iter().all(|c| !c.polling && c.busy_percent < 40.0 && c.busy_ratio == 0.0));
        let t = topology();
        assert_eq!((t.sockets, t.cpus[5].socket, t.cpus[5].plane.as_str(), t.cpus[5].worker), (2, 1, "worker", 2));
    }
}
