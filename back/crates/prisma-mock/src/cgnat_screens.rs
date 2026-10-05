//! The rest of `show cgnat` as typed screens (Prisma 0.150.3, #63), as the mock
//! answers them: plausible fields from its pools, with a screen in `text`.

use prisma_proto::v1::*;
use tonic::Status;

use crate::state::State;

pub fn translation(st: &State, req: &LookupTranslationRequest) -> Result<Translation, Status> {
    let a: std::net::Ipv4Addr = req.public_address.parse().map_err(|_| Status::invalid_argument(format!("% '{}' is not an address", req.public_address)))?;
    if req.port == 0 || req.port > 65535 {
        return Err(Status::invalid_argument(format!("% {} is not a port", req.port)));
    }
    // The seed pool's outside prefix is 203.0.113.64/27.
    let o = a.octets();
    if !(o[0] == 203 && o[1] == 0 && o[2] == 113 && (64..96).contains(&o[3])) {
        return Err(Status::not_found(format!("% {} is not an outside address of any pool", req.public_address)));
    }
    let pool = st.running.pool_names().first().cloned().unwrap_or_else(|| "RFC6598".into());
    let block = (req.port.saturating_sub(1024)) / 512;
    let subscriber = format!("100.64.{}.{}", block % 250, u32::from(o[3]) - 63);
    let text = format!(
        "Translation {}:{}\n  subscriber {subscriber}\n  pool       {pool}\n  block      {block}\n  source     bpa\n",
        req.public_address, req.port
    );
    Ok(Translation {
        public_address: req.public_address.clone(),
        port: req.port,
        subscriber,
        pool,
        block,
        source: translation::Source::Bpa as i32,
        nat64: false,
        now_only: true,
        text,
        ..Default::default()
    })
}

pub fn top(count: u32) -> ListTopResponse {
    let n = if count == 0 { 10 } else { count.min(50) };
    let subscribers: Vec<TopSubscriber> = (0..n)
        .map(|i| TopSubscriber {
            subscriber: format!("100.64.0.{}", i + 1),
            pool: "RFC6598".into(),
            ports_used: 1900 - i * 120,
            ports_total: 2048,
            percent_full: (1900 - i * 120) * 100 / 2048,
            blocks: 4,
            refusals: if i == 0 { 12 } else { 0 },
            ..Default::default()
        })
        .collect();
    let mut text = String::from("Subscriber      Pool     Used/Total  Full  Blocks  Refusals\n");
    for s in &subscribers {
        text += &format!("{:<15} {:<8} {:>4}/{:<5}  {:>3}%  {:>6}  {:>8}\n", s.subscriber, s.pool, s.ports_used, s.ports_total, s.percent_full, s.blocks, s.refusals);
    }
    ListTopResponse { holding_blocks: 4_812, subscribers, text, ..Default::default() }
}

pub fn drops() -> DropsReport {
    let c = |reason: &str, count: u64, dropped: bool| DropCounter { reason: reason.into(), count, dropped, ..Default::default() };
    let nodes = vec![
        DropNode { node: "cgnat-in2out".into(), counters: vec![c("no free port", 12, true), c("session limit", 3, true), c("translated", 98_112_004, false)], ..Default::default() },
        DropNode { node: "cgnat-out2in".into(), counters: vec![c("no session", 4_211, true), c("translated", 97_550_120, false)], ..Default::default() },
    ];
    let mut text = String::new();
    for n in &nodes {
        text += &format!("{}\n", n.node);
        for k in &n.counters {
            text += &format!("  {:>12}  {}{}\n", k.count, k.reason, if k.dropped { " (dropped)" } else { "" });
        }
    }
    DropsReport { nodes, text, ..Default::default() }
}

pub fn memory(st: &State) -> CgnatMemory {
    let sessions = st.subscribers as u64 * 12;
    CgnatMemory {
        heap_bytes: 4 << 30,
        heap_used_bytes: 1_300 << 20,
        sessions,
        sessions_known: true,
        sessions_fit: 4_000_000,
        refused_no_memory: 0,
        given_gb: 4,
        given: true,
        given_in_effect: true,
        text: format!("CGNAT heap 4096 MiB, 1300 MiB used\nsessions {sessions} of 4000000 that fit\nmemory 4 GB (in effect)\n"),
        ..Default::default()
    }
}

pub fn blocks() -> ListBlocksResponse {
    let counts = |k: u64| BlockCounts { in_use: 1_200 * k, blocks: 2_048 * k, allocations: 51_000 * k, extensions: 900 * k, releases: 49_800 * k, refusals: k - 1, pinned: 0, ..Default::default() };
    let workers: Vec<WorkerBlocks> = (1..=4).map(|t| WorkerBlocks { thread: t, counts: Some(counts(1)), lent: 0, ..Default::default() }).collect();
    let pool = PoolBlocks { pool: "RFC6598".into(), holddown_seconds: 60, workers, total: Some(counts(4)), stride: 1, ..Default::default() };
    let mut text = String::from("Pool RFC6598 (holddown 60 s)\n  thread  in use  blocks  allocations  releases  refusals\n");
    for w in &pool.workers {
        let c = w.counts.unwrap_or_default();
        text += &format!("  {:>6}  {:>6}  {:>6}  {:>11}  {:>8}  {:>8}\n", w.thread, c.in_use, c.blocks, c.allocations, c.releases, c.refusals);
    }
    ListBlocksResponse { pools: vec![pool], text, ..Default::default() }
}

pub fn identity() -> IdentityState {
    IdentityState { loaded: false, text: "identity: none loaded, RADIUS off\n".into(), ..Default::default() }
}

pub fn history() -> HistoryVerification {
    HistoryVerification {
        path: "/var/lib/prisma/history.log".into(),
        verdict: history_verification::Verdict::Intact as i32,
        checked: 128,
        head_seq: 128,
        head_sha256: "9f2c…".into(),
        text: "history /var/lib/prisma/history.log: intact, 128 entries checked\n".into(),
        ..Default::default()
    }
}

pub fn algs(st: &State) -> ListAlgsResponse {
    let names = ["ftp", "rtsp", "pptp", "esp", "sip"];
    let pools: Vec<PoolAlgs> = st
        .running
        .pool_names()
        .into_iter()
        .map(|p| PoolAlgs {
            algs: names
                .iter()
                .map(|a| AlgState { alg: (*a).into(), on: *a != "sip", description: format!("{} application gateway", a.to_uppercase()), ..Default::default() })
                .collect(),
            pool: p,
            ..Default::default()
        })
        .collect();
    let mut text = String::new();
    for p in &pools {
        text += &format!("{}: {}\n", p.pool, p.algs.iter().map(|a| format!("{} {}", a.alg, if a.on { "on" } else { "off" })).collect::<Vec<_>>().join(", "));
    }
    ListAlgsResponse { pools, text, ..Default::default() }
}

pub fn forwards(pool: &str) -> ListForwardsResponse {
    let all = vec![Forward {
        pool: "RFC6598".into(),
        protocol: "tcp".into(),
        public_address: "203.0.113.70".into(),
        public_port: 8443,
        private_address: "100.64.3.9".into(),
        private_port: 443,
        ..Default::default()
    }];
    let forwards: Vec<Forward> = all.into_iter().filter(|f| pool.is_empty() || f.pool == pool).collect();
    let text = forwards.iter().map(|f| format!("{} {} {}:{} -> {}:{}\n", f.pool, f.protocol, f.public_address, f.public_port, f.private_address, f.private_port)).collect();
    ListForwardsResponse { forwards, text, ..Default::default() }
}

pub fn ha() -> HaStatus {
    HaStatus {
        dataplane: true,
        fingerprint: "a41c9e".into(),
        pools: vec!["RFC6598".into()],
        routers: vec![HaRouter { interface: "lan0".into(), vr_id: 10, state: "master".into(), addresses: vec!["192.168.10.254".into()], priority_configured: 200, priority_advertised: 200, ..Default::default() }],
        peer_read: false,
        peer_unread: "no peer copy configured".into(),
        agree: false,
        text: "HA: dataplane up, fingerprint a41c9e\n  vrrp lan0 vrid 10 master (200)\n  peer: no copy configured\n".into(),
        ..Default::default()
    }
}
