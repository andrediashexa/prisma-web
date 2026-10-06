//! `OperationalService`: typed operational data and `Show` with output
//! in the VTY/FRR format.

use std::net::{IpAddr, Ipv4Addr};

use prisma_proto::v1::diagnostic::Severity;
use prisma_proto::v1::operational_service_server::OperationalService;
use prisma_proto::v1::*;
use prisma_proto::with_diagnostics;
use rand::Rng;
use tonic::{Request, Response, Status};

use crate::config::{self, diag};
use crate::state::{SharedRef, State};

pub struct OperationalSvc {
    pub shared: SharedRef,
    pub hostname: String,
}

type R<T> = Result<Response<T>, Status>;

const RELEASE: &str = "0.149.0-mock";

/// `MOCK_RELEASE` overrides the release the mock reports (#51: prisma-mock-2 is a 0.149.26
/// box whose account has no `operator`).
/// Whether the release the mock reports is `min` or newer.
pub fn release_at_least(min: (u32, u32, u32)) -> bool {
    let r = release();
    let mut it = r.split(['.', '-']).map(|n| n.parse::<u32>().ok());
    matches!((it.next().flatten(), it.next().flatten(), it.next().flatten()), (Some(a), Some(b), Some(c)) if (a, b, c) >= min)
}

fn release() -> String {
    std::env::var("MOCK_RELEASE").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| RELEASE.into())
}

fn workers_floor(capacity: u64) -> u64 {
    // Guaranteed per worker (5 workers), like the floor in #210.
    capacity / 5 * 5 * 9 / 10
}

/// One pool of the running configuration; the simulated subscribers are on
/// the seed's pool, the others are empty (#41).
fn pool(st: &State, name: &str) -> Pool {
    let c = &st.running;
    let block_size = c.pool_block_size(name).max(1);
    let capacity = c.pool_outside_addresses(name) * u64::from(64_512 / block_size);
    let subscribers = if name == config::SEED_POOL { (st.subscribers as u64).min(capacity) } else { 0 };
    Pool {
        name: name.into(),
        mode: c.pool_line(name, "mode ", "bpa"),
        level: "cgnat".into(),
        policy: c.pool_line(name, "policy ", "interleaved"),
        block_size,
        // What the dataplane maps: typed, or what a list resolves to (0.151.12, #73).
        prefixes_inside: c.pool_side(name, "inside").0,
        prefixes_outside: c.pool_side(name, "outside").0,
        prefix_list_inside: c.pool_list(name, "inside"),
        prefix_list_outside: c.pool_list(name, "outside"),
        untranslated: c.pool_side(name, "inside").1,
        outside_excluded: c.pool_side(name, "outside").1,
        capacity,
        guaranteed: workers_floor(capacity),
        subscribers,
        ports_in_use: subscribers * 180,
        refusals: if name == config::SEED_POOL { st.refusals } else { 0 },
        sessions: subscribers * 35,
        ..Default::default()
    }
}

fn interfaces(st: &State, names: &[String]) -> Vec<Interface> {
    st.running
        .interfaces
        .iter()
        .filter(|i| names.is_empty() || names.contains(&i.name))
        .map(|i| {
            let sim = st.sim(&i.name);
            Interface {
                name: i.name.clone(),
                admin_up: !i.shutdown,
                link_up: i.name == "lo" || !i.shutdown,
                mtu: i.mtu,
                mac_address: sim.and_then(|s| s.mac.clone()).unwrap_or_default(),
                addresses: i.v4.iter().chain(&i.v6).cloned().collect(),
                linux_name: if i.name == "lo" { String::new() } else { format!("vpp-{}", i.name) },
                description: i.description.clone().unwrap_or_default(),
                counters: sim.map(|s| s.counters),
                speed_bps: speed_bps(&i.name),
                ..Default::default()
            }
        })
        .collect()
}

/// Physical ports at 10G; the VLAN sub-interface reports VPP's unknown
/// (u32::MAX kbps, 4294967295000 bps, as Prisma 0.149.2 passes it on); the
/// other virtual ones have no speed (0, as 0.149.3 reports it).
fn speed_bps(name: &str) -> u64 {
    match name {
        n if n.starts_with("wan") || n == "lan0" => 10_000_000_000,
        "lan0.20" => u64::from(u32::MAX) * 1000,
        _ => 0,
    }
}

/// Each worker's load, varying with the subscribers and a little noise;
/// the last worker runs near saturation (busy_ratio about 0.5, #25).
fn worker_load(st: &State) -> Vec<WorkerLoad> {
    let mut rng = rand::thread_rng();
    let level = (st.subscribers / 5_500.0).clamp(0.2, 1.5);
    (0..5u32)
        .map(|w| {
            let base = if w == 4 { 0.42 } else { 0.08 + f64::from(w) * 0.04 };
            let busy = (base * level.sqrt() + rng.gen_range(-0.02..0.02)).clamp(0.0, 0.52);
            WorkerLoad {
                worker: w,
                cpu: 3 + w,
                vectors_per_call: (1.0 + busy / 0.5 * 200.0 * rng.gen_range(0.95..1.05)).min(256.0),
                busy_ratio: (busy * 1000.0).round() / 1000.0,
                loops_per_second: (42_000.0 - busy * 60_000.0) * rng.gen_range(0.98..1.02),
                busy_window_ms: 5000,
                ..Default::default()
            }
        })
        .collect()
}

fn hms(secs: u64) -> String {
    let (d, h, m) = (secs / 86_400, secs % 86_400 / 3600, secs % 3600 / 60);
    if d > 0 { format!("{d}d{h:02}h{m:02}m") } else { format!("{h:02}:{m:02}:{:02}", secs % 60) }
}

/// The line-only mock stands for a box before 0.150.3 (and 0.150.6) too (#63, #64).
fn before_0_150_3() -> Result<(), Status> {
    if crate::typed::disabled() {
        return Err(Status::unimplemented("MOCK_NO_TYPED: a box before 0.150.3"));
    }
    Ok(())
}

impl OperationalSvc {
    fn bgp(&self, st: &State) -> Vec<BgpNeighbor> {
        let branch = self.hostname.contains("branch");
        st.running
            .bgp_neighbors()
            .into_iter()
            .map(|(peer, asn)| {
                let v6 = peer.contains(':');
                let down = v6 && branch;
                // `neighbor <peer> shutdown` holds the session down, as FRR shows it (#42).
                let admin_down = st.running.bgp_neighbor_shutdown(&peer);
                let up = !down && !admin_down;
                BgpNeighbor {
                    vrf: "default".into(),
                    remote_as: asn,
                    state: if admin_down { "Idle (Admin)".into() } else if down { "Active".into() } else { "Established".into() },
                    uptime_seconds: match (up, st.bgp_reset.get(&peer)) {
                        (false, _) => 0,
                        (true, Some(at)) => st.uptime_seconds().saturating_sub(*at),
                        (true, None) => st.uptime_seconds().saturating_sub(600),
                    },
                    prefixes_received: if !up { 0 } else if v6 { 201_388 } else { 1_002_117 },
                    description: st
                        .running
                        .bgp_neighbor_description(&peer)
                        .unwrap_or_else(|| if v6 { "IPv6 transit".into() } else { "IPv4 transit".into() }),
                    peer,
                    ..Default::default()
                }
            })
            .collect()
    }

    fn show(&self, st: &State, command: &str) -> Result<String, Status> {
        let words: Vec<&str> = command.split_whitespace().collect();
        let refuse = |msg: String| {
            let d = diag(Severity::Error, msg.clone(), &[], command);
            with_diagnostics(Status::invalid_argument(msg.clone()), &Diagnostics { items: vec![d], output: msg, ..Default::default() })
        };
        let Some(first) = words.first() else { return Err(refuse("% Empty command".into())) };
        if matches!(*first, "configure" | "set" | "delete" | "commit" | "rollback" | "save" | "shell" | "start" | "edit") {
            return Err(refuse(format!("not an operational command: {command}")));
        }
        match words.as_slice() {
            ["show", "ip", "route"] => Ok(self.routes(st, false)),
            ["show", "ipv6", "route"] => Ok(self.routes(st, true)),
            ["show", "bgp", "summary"] => Ok(self.bgp_summary(st)),
            ["show", "version"] => Ok(format!(
                "Prisma {} ({})\nplugin 0.149.0-mock+g1a2b3c (current)\nvpp 25.06\nfrr 10.3\nuptime {}\n",
                release(),
                self.hostname,
                hms(st.uptime_seconds())
            )),
            ["show", "interfaces"] => {
                let mut out = format!("{:<10} {:<6} {:<6} {:>6} {:>18} {:>18}\n", "Interface", "Admin", "Link", "MTU", "RX bytes", "TX bytes");
                for i in interfaces(st, &[]) {
                    let c = i.counters.unwrap_or_default();
                    out += &format!(
                        "{:<10} {:<6} {:<6} {:>6} {:>18} {:>18}\n",
                        i.name,
                        if i.admin_up { "up" } else { "down" },
                        if i.link_up { "up" } else { "down" },
                        i.mtu,
                        c.rx_bytes,
                        c.tx_bytes
                    );
                }
                Ok(out)
            }
            ["ping", target, ..] => {
                let addr: IpAddr = target.parse().map_err(|_| refuse(format!("% Invalid address: {target}")))?;
                let mut out = format!("PING {addr} ({addr}): 56 data bytes\n");
                let base = if addr.is_ipv4() { 3.1 } else { 3.4 };
                let mut rtts = Vec::new();
                for seq in 0..4 {
                    let rtt = base + f64::from(seq % 3) * 0.17;
                    rtts.push(rtt);
                    out += &format!("64 bytes from {addr}: icmp_seq={seq} ttl=58 time={rtt:.3} ms\n");
                }
                let avg = rtts.iter().sum::<f64>() / rtts.len() as f64;
                out += &format!(
                    "\n--- {addr} ping statistics ---\n4 packets transmitted, 4 packets received, 0.0% packet loss\nround-trip min/avg/max = {:.3}/{avg:.3}/{:.3} ms\n",
                    rtts.iter().cloned().fold(f64::MAX, f64::min),
                    rtts.iter().cloned().fold(0.0, f64::max)
                );
                Ok(out)
            }
            _ => Err(refuse(format!("% Unknown command: {command}"))),
        }
    }

    fn routes(&self, st: &State, v6: bool) -> String {
        let up = |n: &str| st.running.iface(n).is_some_and(|i| !i.shutdown);
        let age = hms(st.uptime_seconds());
        let mut out = String::from(
            "Codes: K - kernel route, C - connected, L - local, S - static,\n       O - OSPF, I - IS-IS, B - BGP,\n       > - selected route, * - FIB route\n\n",
        );
        if up("wan0") {
            let (dst, via) = if v6 { ("::/0", "fe80::1") } else { ("0.0.0.0/0", "203.0.113.9") };
            out += &format!("B>* {dst} [20/0] via {via}, wan0, weight 1, {age}\n");
        }
        for i in &st.running.interfaces {
            if i.shutdown || i.name == "lo" {
                continue;
            }
            for a in if v6 { &i.v6 } else { &i.v4 } {
                if let Some(net) = config::network(a) {
                    out += &format!("C>* {net} is directly connected, {}, {age}\n", i.name);
                }
                let host = a.split('/').next().unwrap_or_default();
                out += &format!("L>* {host}/{} is directly connected, {}, {age}\n", if v6 { 128 } else { 32 }, i.name);
            }
        }
        if !v6 && up("wg0") {
            out += &format!("S>* 172.16.0.0/16 [1/0] via 10.8.0.2, wg0, weight 1, {age}\n");
        }
        let learned = self.bgp(st).iter().filter(|n| n.peer.contains(':') == v6).map(|n| n.prefixes_received).sum::<u64>();
        if learned > 0 && up("wan0") {
            out += &format!("\n{learned} BGP routes not shown (use \"show {} route bgp\")\n", if v6 { "ipv6" } else { "ip" });
        }
        out
    }

    fn bgp_summary(&self, st: &State) -> String {
        let mut out = format!(
            "BGP router identifier 203.0.113.10, local AS number 65000 vrf-id 0\n\n{:<26} {:>2} {:>8} {:>10} {:<12} {:>10}\n",
            "Neighbor", "V", "AS", "Up/Down", "State", "PfxRcd"
        );
        for n in self.bgp(st) {
            let updown = if n.uptime_seconds == 0 { "never".to_string() } else { hms(n.uptime_seconds) };
            out += &format!("{:<26} {:>2} {:>8} {:>10} {:<12} {:>10}\n", n.peer, 4, n.remote_as, updown, n.state, n.prefixes_received);
        }
        out
    }
}

#[tonic::async_trait]
impl OperationalService for OperationalSvc {
    async fn get_version(&self, _: Request<GetVersionRequest>) -> R<VersionInfo> {
        let _turno = self.shared.ops.lock().await;
        Ok(Response::new(VersionInfo {
            release: release(),
            plugin_build: "0.149.0-mock+g1a2b3c".into(),
            dataplane_current: true,
            vpp_version: "25.06".into(),
            frr_version: "10.3".into(),
            hostname: self.hostname.clone(),
            api_transport: "vpp_papi".into(),
            ..Default::default()
        }))
    }

    async fn get_system(&self, _: Request<GetSystemRequest>) -> R<SystemInfo> {
        let _turno = self.shared.ops.lock().await;
        let st = self.shared.state.lock().unwrap();
        let mib = st.mem_used >> 20;
        let cpu_text = "\
CPU  Role           Thread      Vectors/call  Loops/s
0    control-plane  -           -             -
1    control-plane  -           -             -
2    main           vpp_main    1.02          41233
3    worker         vpp_wk_0    18.71         38211
4    worker         vpp_wk_1    17.93         38490
5    worker         vpp_wk_2    19.40         37902
6    worker         vpp_wk_3    18.05         38377
7    worker         vpp_wk_4    16.88         39011
"
        .to_string();
        let memory_text = format!(
            "\
              Total      Used      Free
System      32768 MiB {:>6} MiB {:>6} MiB
Hugepages   16384 MiB  16384 MiB      0 MiB  (16 x 1G)
VPP heap     4096 MiB {:>6} MiB {:>6} MiB
",
            mib,
            32_768 - mib,
            1_200 + mib % 700,
            4_096 - 1_200 - mib % 700
        );
        // Uptime breakdown of Prisma 0.148.7 (#20). MOCK_DATAPLANE_RESTARTED=1
        // makes the dataplane look like it restarted by itself 15 minutes ago.
        let now = chrono::Utc::now();
        let boot = now - chrono::Duration::seconds(st.uptime_seconds() as i64);
        let restarted = std::env::var("MOCK_DATAPLANE_RESTARTED").is_ok_and(|v| v == "1");
        // MOCK_NO_LOAD_NUMBERS=1 answers like a box before 0.149.2: memory and
        // worker load only as text.
        let legacy = std::env::var("MOCK_NO_LOAD_NUMBERS").is_ok_and(|v| v == "1");
        let dataplane = if restarted { now - chrono::Duration::minutes(15) } else { boot + chrono::Duration::seconds(40) };
        // Why each last started (0.151.14, #75): as recorded; "" before it, or a start not recorded.
        let (dataplane, dataplane_cause) = match &st.dataplane_start {
            Some((at, cause)) => (*at, cause.clone()),
            None => (dataplane, if restarted { "unexpected".to_string() } else { "boot".to_string() }),
        };
        let restarted = restarted || st.dataplane_start.is_some();
        let recorded = crate::box_log::recorded();
        let ts = |t: chrono::DateTime<chrono::Utc>| Some(prost_types::Timestamp { seconds: t.timestamp(), nanos: 0 });
        // Third-party SFP+ modules (0.151.2, #69): configured, and as the mock last "booted".
        let sfp_configured = st.running.unsupported_sfp_allowed();
        let sfp_booted = st.unsupported_sfp_booted;
        Ok(Response::new(SystemInfo {
            unsupported_sfp_configured: sfp_configured,
            unsupported_sfp_booted: sfp_booted,
            unsupported_sfp_booted_known: true,
            hardware_text: format!(
                "unsupported-sfp: {} (booted: {})\n",
                if sfp_configured { "allow" } else { "refuse" },
                if sfp_booted { "allow" } else { "refuse" }
            ),
            boot_time: ts(boot),
            dataplane_started: ts(dataplane),
            control_plane_started: ts(boot + chrono::Duration::seconds(50)),
            vty_started: ts(boot + chrono::Duration::seconds(55)),
            last_boot_reason: "system reboot by admin".into(),
            release_installed_at: ts(boot - chrono::Duration::hours(2)),
            dataplane_restarted: restarted,
            dataplane_start_cause: if recorded { dataplane_cause } else { String::new() },
            control_plane_start_cause: if recorded { "boot".into() } else { String::new() },
            // Memory and worker load in numbers (Prisma 0.149.2). busy_ratio is
            // VPP's share of node clocks: a saturated worker reads about 0.5.
            memory_total_bytes: if legacy { 0 } else { 32 << 30 },
            // MemTotal less MemAvailable: the reserved hugepages count as used.
            memory_used_bytes: if legacy { 0 } else { (16 << 30) + st.mem_used },
            memory_hugepages_bytes: if legacy { 0 } else { 16 << 30 },
            worker_load: if legacy { Vec::new() } else { worker_load(&st) },
            hostname: self.hostname.clone(),
            uptime_seconds: st.uptime_seconds(),
            control_plane_cpus: "0-1".into(),
            main_thread_cpu: "2".into(),
            worker_cpus: "3-7".into(),
            workers: 5,
            hugepages: 16,
            cpu_text,
            memory_text,
            ..Default::default()
        }))
    }

    async fn list_interfaces(&self, req: Request<ListInterfacesRequest>) -> R<ListInterfacesResponse> {
        let _turno = self.shared.ops.lock().await;
        let names = req.into_inner().names;
        let st = self.shared.state.lock().unwrap();
        Ok(Response::new(ListInterfacesResponse { interfaces: interfaces(&st, &names), ..Default::default() }))
    }

    async fn list_pools(&self, _: Request<ListPoolsRequest>) -> R<ListPoolsResponse> {
        let _turno = self.shared.ops.lock().await;
        let st = self.shared.state.lock().unwrap();
        let mut pools: Vec<Pool> = st.running.pool_names().iter().map(|n| pool(&st, n)).collect();
        // NAT64 pools (`nat > nat64`, 0.151.0, #68), their `level` saying so.
        for n in st.running.nat64_pool_names() {
            let p = crate::typed::nat64_pool(&st.running, &n);
            pools.push(Pool {
                name: n,
                mode: if p.mode.is_empty() { "bpa".into() } else { p.mode },
                policy: if p.policy.is_empty() { "interleaved".into() } else { p.policy },
                block_size: p.block_size.max(512),
                prefixes_inside: p.prefix_inside,
                prefixes_outside: p.prefix_outside,
                level: "nat64".into(),
                ..Default::default()
            });
        }
        Ok(Response::new(ListPoolsResponse { pools, ..Default::default() }))
    }

    // The rest of `show cgnat`, typed (0.150.3, #63); a box before it (the line-only mock) has none.
    async fn lookup_translation(&self, req: Request<LookupTranslationRequest>) -> R<Translation> {
        before_0_150_3()?;
        let st = self.shared.state.lock().unwrap();
        crate::cgnat_screens::translation(&st, req.get_ref()).map(Response::new)
    }
    async fn list_top(&self, req: Request<ListTopRequest>) -> R<ListTopResponse> {
        before_0_150_3()?;
        Ok(Response::new(crate::cgnat_screens::top(req.get_ref().count)))
    }
    async fn get_drops(&self, _: Request<GetDropsRequest>) -> R<DropsReport> {
        before_0_150_3()?;
        Ok(Response::new(crate::cgnat_screens::drops()))
    }
    async fn get_cgnat_memory(&self, _: Request<GetCgnatMemoryRequest>) -> R<CgnatMemory> {
        before_0_150_3()?;
        Ok(Response::new(crate::cgnat_screens::memory(&self.shared.state.lock().unwrap())))
    }
    async fn list_blocks(&self, _: Request<ListBlocksRequest>) -> R<ListBlocksResponse> {
        before_0_150_3()?;
        Ok(Response::new(crate::cgnat_screens::blocks()))
    }
    async fn get_identity(&self, _: Request<GetIdentityRequest>) -> R<IdentityState> {
        before_0_150_3()?;
        Ok(Response::new(crate::cgnat_screens::identity()))
    }
    async fn verify_history(&self, _: Request<VerifyHistoryRequest>) -> R<HistoryVerification> {
        before_0_150_3()?;
        Ok(Response::new(crate::cgnat_screens::history()))
    }
    async fn list_algs(&self, _: Request<ListAlgsRequest>) -> R<ListAlgsResponse> {
        before_0_150_3()?;
        Ok(Response::new(crate::cgnat_screens::algs(&self.shared.state.lock().unwrap())))
    }
    async fn list_forwards(&self, req: Request<ListForwardsRequest>) -> R<ListForwardsResponse> {
        before_0_150_3()?;
        Ok(Response::new(crate::cgnat_screens::forwards(&req.get_ref().pool)))
    }
    async fn get_ha_status(&self, _: Request<GetHaStatusRequest>) -> R<HaStatus> {
        before_0_150_3()?;
        Ok(Response::new(crate::cgnat_screens::ha()))
    }

    // The rest of the screens and the probes (0.150.6, #64); the line-only mock has none.
    async fn list_ospf_interfaces(&self, _: Request<ListOspfInterfacesRequest>) -> R<OspfInterfaces> {
        before_0_150_3()?;
        Ok(Response::new(crate::screens::ospf_interfaces()))
    }
    async fn list_isis_interfaces(&self, _: Request<ListIsisInterfacesRequest>) -> R<IsisInterfaces> {
        before_0_150_3()?;
        Ok(Response::new(crate::screens::isis_interfaces()))
    }
    async fn get_hardware(&self, _: Request<GetHardwareRequest>) -> R<Hardware> {
        before_0_150_3()?;
        Ok(Response::new(crate::screens::hardware()))
    }
    async fn get_routing_logging(&self, _: Request<GetRoutingLoggingRequest>) -> R<RoutingLogging> {
        before_0_150_3()?;
        Ok(Response::new(crate::screens::routing_logging()))
    }
    async fn get_snmp_file(&self, req: Request<GetSnmpFileRequest>) -> R<SnmpFile> {
        before_0_150_3()?;
        crate::screens::snmp_file(req.get_ref().kind).map(Response::new)
    }
    async fn ping(&self, req: Request<ProbeRequest>) -> Result<Response<tonic::codegen::BoxStream<ProbeEvent>>, Status> {
        before_0_150_3()?;
        crate::screens::probe("ping", req.into_inner()).map(Response::new)
    }
    async fn traceroute(&self, req: Request<ProbeRequest>) -> Result<Response<tonic::codegen::BoxStream<ProbeEvent>>, Status> {
        before_0_150_3()?;
        crate::screens::probe("traceroute", req.into_inner()).map(Response::new)
    }
    async fn mtr(&self, req: Request<ProbeRequest>) -> Result<Response<tonic::codegen::BoxStream<ProbeEvent>>, Status> {
        before_0_150_3()?;
        crate::screens::probe("mtr", req.into_inner()).map(Response::new)
    }

    // What the boot left out (0.151.5, #70).
    // `show interface transceiver` (0.151.15, #76); a box before it has no such call.
    async fn list_transceivers(&self, req: Request<ListTransceiversRequest>) -> R<Transceivers> {
        if !crate::transceivers::answered() {
            return Err(Status::unimplemented("ListTransceivers is not in this release"));
        }
        let st = self.shared.state.lock().unwrap();
        if st.old_plugin {
            return Ok(Response::new(crate::transceivers::old_plugin()));
        }
        Ok(Response::new(crate::transceivers::list(&req.get_ref().names, st.wan0_rx_mw)))
    }

    // `show log` (0.151.14, #75); a box before it has no such call.
    async fn list_events(&self, req: Request<ListEventsRequest>) -> R<ListEventsResponse> {
        if !crate::box_log::recorded() {
            return Err(Status::unimplemented("ListEvents is not in this release"));
        }
        let mut st = self.shared.state.lock().unwrap();
        if st.box_log.is_empty() {
            let boot = chrono::Utc::now() - chrono::Duration::seconds(st.uptime_seconds() as i64);
            st.box_log = crate::box_log::seed(boot);
        }
        crate::box_log::list(&st.box_log, req.get_ref(), chrono::Utc::now()).map(Response::new)
    }

    async fn get_pending_configuration(&self, _: Request<GetPendingConfigurationRequest>) -> R<PendingConfiguration> {
        before_0_150_3()?;
        Ok(Response::new(self.shared.state.lock().unwrap().boot_pending.clone().unwrap_or_default()))
    }

    // BFD (0.150.10, #66).
    async fn list_bfd_sessions(&self, req: Request<ListBfdSessionsRequest>) -> R<BfdSessions> {
        before_0_150_3()?;
        let peer = req.into_inner().peer;
        if !peer.is_empty() && peer.parse::<IpAddr>().is_err() {
            return Err(Status::invalid_argument(format!("% '{peer}' is not an address")));
        }
        let st = self.shared.state.lock().unwrap();
        let sessions: Vec<_> = crate::screens::bfd_sessions(&st).into_iter().filter(|s| peer.is_empty() || s.peer == peer).collect();
        let text = crate::screens::bfd_text(&sessions);
        Ok(Response::new(BfdSessions { answered: true, sessions, text }))
    }

    async fn watch_bfd(&self, req: Request<WatchBfdRequest>) -> Result<Response<tonic::codegen::BoxStream<BfdEvent>>, Status> {
        use prisma_proto::v1::bfd_event::Kind;
        before_0_150_3()?;
        let every = match req.into_inner().interval_seconds {
            0 => 2,
            n => n.clamp(1, 60),
        };
        let shared = self.shared.clone();
        let (tx, rx) = tokio::sync::mpsc::channel(32);
        tokio::spawn(async move {
            let now = || Some(crate::state::timestamp(chrono::Utc::now()));
            let mut last = crate::screens::bfd_sessions(&shared.state.lock().unwrap());
            for s in &last {
                if tx.send(Ok(BfdEvent { kind: Kind::Initial as i32, at: now(), session: Some(s.clone()), ..Default::default() })).await.is_err() {
                    return;
                }
            }
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(every.into())) => {}
                    _ = tx.closed() => return,
                }
                let cur = crate::screens::bfd_sessions(&shared.state.lock().unwrap());
                let mut out = vec![];
                for s in &cur {
                    match last.iter().find(|x| x.peer == s.peer) {
                        None => out.push(BfdEvent { kind: Kind::Appeared as i32, at: now(), session: Some(s.clone()), ..Default::default() }),
                        Some(x) if x.state != s.state => out.push(BfdEvent { kind: Kind::Changed as i32, at: now(), session: Some(s.clone()), previous_state: x.state }),
                        _ => {}
                    }
                }
                for x in last.iter().filter(|x| !cur.iter().any(|s| s.peer == x.peer)) {
                    out.push(BfdEvent { kind: Kind::Gone as i32, at: now(), session: Some(x.clone()), previous_state: x.state });
                }
                last = cur;
                for e in out {
                    if tx.send(Ok(e)).await.is_err() {
                        return;
                    }
                }
            }
        });
        Ok(Response::new(Box::pin(tokio_stream::wrappers::ReceiverStream::new(rx))))
    }

    async fn get_subscriber(&self, req: Request<GetSubscriberRequest>) -> R<Subscriber> {
        let _turno = self.shared.ops.lock().await;
        let address = req.into_inner().address;
        let inside = address
            .parse::<Ipv4Addr>()
            .ok()
            .filter(|a| u32::from(*a) & 0xffc0_0000 == u32::from(Ipv4Addr::new(100, 64, 0, 0)));
        let Some(addr) = inside else {
            return Err(Status::not_found(format!("no subscriber {address}")));
        };
        let st = self.shared.state.lock().unwrap();
        let p = pool(&st, config::SEED_POOL);
        let h = u32::from(addr);
        let block_size = p.block_size.max(1);
        let block = |n: u32| {
            let public = Ipv4Addr::new(203, 0, 113, 64 + ((h + n) % 32) as u8);
            let first = 1024 + ((h / 32 + n) % (64_512 / block_size)) * block_size;
            PortBlock { public_address: public.to_string(), first_port: first, last_port: first + block_size - 1, ..Default::default() }
        };
        let blocks: Vec<PortBlock> = if h % 3 == 0 { vec![block(0), block(1)] } else { vec![block(0)] };
        let sessions = u64::from(h % 120) + 4;
        let mut text = format!("Subscriber {address}\n  pool       RFC6598 ({})\n  sessions   {sessions}\n  blocks\n", p.mode);
        for b in &blocks {
            text += &format!("    {}:{}-{}\n", b.public_address, b.first_port, b.last_port);
        }
        Ok(Response::new(Subscriber { address, pool: p.name, blocks, sessions, text, ..Default::default() }))
    }

    async fn get_sessions_summary(&self, _: Request<GetSessionsSummaryRequest>) -> R<SessionsSummary> {
        let _turno = self.shared.ops.lock().await;
        let st = self.shared.state.lock().unwrap();
        let p = pool(&st, config::SEED_POOL);
        Ok(Response::new(SessionsSummary {
            sessions: p.sessions,
            sessions_fit: 4_000_000,
            subscribers: p.subscribers,
            ports_in_use: p.ports_in_use,
            ..Default::default()
        }))
    }

    /// The VTY's `clear` lines (0.149.25, #48), as the box answers them.
    async fn clear(&self, req: Request<ClearRequest>) -> R<ClearResponse> {
        use clear_request::{BgpMode, Target};
        if crate::typed::disabled() {
            return Err(Status::unimplemented("Clear (MOCK_NO_TYPED: a box before 0.149.25)"));
        }
        let req = req.into_inner();
        let name = req.name.as_str();
        if name.split_whitespace().count() > 1 {
            let d = Diagnostics { reason: diagnostics::Reason::Usage as i32, output: format!("'{name}' is not one word"), ..Default::default() };
            return Err(with_diagnostics(Status::invalid_argument(d.output.clone()), &d));
        }
        let _turno = self.shared.ops.lock().await;
        let mut st = self.shared.state.lock().unwrap();
        let precondition = |m: String| Err(Status::failed_precondition(m));
        let command = match req.target() {
            Target::InterfaceCounters => {
                if !name.is_empty() && st.sim(name).is_none() {
                    return precondition(format!("% Unknown interface {name}"));
                }
                for s in st.sims.iter_mut().filter(|s| name.is_empty() || s.name == name) {
                    s.counters = InterfaceCounters::default();
                }
                if name.is_empty() { "clear interface counters".to_string() } else { format!("clear interface counters {name}") }
            }
            Target::CgnatSubscriber => {
                if name.parse::<std::net::IpAddr>().is_err() {
                    let d = Diagnostics { reason: diagnostics::Reason::Usage as i32, output: format!("'{name}' is not an address"), ..Default::default() };
                    return Err(with_diagnostics(Status::invalid_argument(d.output.clone()), &d));
                }
                format!("clear cgnat subscriber {name}")
            }
            Target::Bgp => {
                let peers: Vec<String> = st.running.bgp_neighbors().into_iter().map(|(p, _)| p).filter(|p| name.is_empty() || name == "*" || p == name).collect();
                if peers.is_empty() {
                    return precondition(format!("% BGP: Unknown neighbor - \"{name}\""));
                }
                let mode = match req.bgp() {
                    BgpMode::BgpHard => "",
                    BgpMode::BgpSoft => " soft",
                    BgpMode::BgpSoftIn => " soft in",
                    BgpMode::BgpSoftOut => " soft out",
                };
                if mode.is_empty() {
                    let now = st.uptime_seconds();
                    for p in peers {
                        st.bgp_reset.insert(p, now);
                    }
                }
                format!("clear ip bgp {}{mode}", if name.is_empty() { "*" } else { name })
            }
            Target::OspfProcess => "clear ip ospf process".to_string(),
            Target::OspfNeighbor => if name.is_empty() { "clear ip ospf neighbor".to_string() } else { format!("clear ip ospf neighbor {name}") },
            Target::IsisAdjacency => if name.is_empty() { "clear isis neighbor".to_string() } else { format!("clear isis neighbor {name}") },
            Target::ConfigurationPending => {
                let had = st.boot_pending.take().is_some();
                // The state's lock is held here: the health follows on its own task.
                let shared = self.shared.clone();
                tokio::spawn(async move { shared.set_pending(None).await });
                return Ok(Response::new(ClearResponse {
                    output: if had { "the statements the boot left out are given up".into() } else { "nothing is pending".into() },
                    command: "clear configuration pending".into(),
                }));
            }
            Target::Unspecified => {
                let d = Diagnostics { reason: diagnostics::Reason::Usage as i32, output: "a target is required".into(), ..Default::default() };
                return Err(with_diagnostics(Status::invalid_argument(d.output.clone()), &d));
            }
        };
        Ok(Response::new(ClearResponse { output: String::new(), command, ..Default::default() }))
    }

    async fn list_bgp_neighbors(&self, _: Request<ListBgpNeighborsRequest>) -> R<ListBgpNeighborsResponse> {
        let _turno = self.shared.ops.lock().await;
        let st = self.shared.state.lock().unwrap();
        Ok(Response::new(ListBgpNeighborsResponse { neighbors: self.bgp(&st), ..Default::default() }))
    }

    async fn list_ospf_neighbors(&self, _: Request<ListOspfNeighborsRequest>) -> R<ListOspfNeighborsResponse> {
        let _turno = self.shared.ops.lock().await;
        Ok(Response::new(ListOspfNeighborsResponse {
            neighbors: vec![
                OspfNeighbor {
                    protocol: "ospf".into(),
                    router_id: "192.168.10.2".into(),
                    address: "192.168.10.2".into(),
                    interface: "lan0".into(),
                    state: "Full/DR".into(),
                    ..Default::default()
                },
                OspfNeighbor {
                    protocol: "ospf6".into(),
                    router_id: "192.168.10.2".into(),
                    address: "fe80::5054:ff:fea1:10".into(),
                    interface: "lan0".into(),
                    state: "Full/DR".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }))
    }

    async fn list_isis_adjacencies(&self, _: Request<ListIsisAdjacenciesRequest>) -> R<ListIsisAdjacenciesResponse> {
        let _turno = self.shared.ops.lock().await;
        Ok(Response::new(ListIsisAdjacenciesResponse {
            adjacencies: vec![IsisAdjacency {
                system_id: "0000.0000.0002".into(),
                interface: "lan0".into(),
                state: "Up".into(),
                level: "L2".into(),
                ..Default::default()
            }],
            ..Default::default()
        }))
    }

    async fn list_vrrp(&self, _: Request<ListVrrpRequest>) -> R<ListVrrpResponse> {
        let _turno = self.shared.ops.lock().await;
        let vr = |family, addr: &str| VrrpRouter {
            interface: "lan0".into(),
            vr_id: 10,
            family,
            state: "master".into(),
            priority: 200,
            addresses: vec![addr.into()],
            ..Default::default()
        };
        Ok(Response::new(ListVrrpResponse { routers: vec![vr(4, "192.168.10.254"), vr(6, "2001:db8:200:10::fe")], ..Default::default() }))
    }

    async fn list_bundles(&self, _: Request<ListBundlesRequest>) -> R<ListBundlesResponse> {
        let _turno = self.shared.ops.lock().await;
        let members = vec!["TenGig0".to_string(), "TenGig1".to_string()];
        let mut bundles = vec![Bundle { name: "BondEthernet0".into(), mode: "lacp".into(), active_members: members.clone(), members, ..Default::default() }];
        // The bundles configured through `interface bond<n>` (#40); a member is active while it is up.
        let st = self.shared.state.lock().unwrap();
        for (b, members) in st.running.bundles() {
            let up = |m: &String| !b.shutdown && st.running.iface(m).is_some_and(|i| !i.shutdown);
            let active_members = members.iter().filter(|m| up(m)).cloned().collect();
            bundles.push(Bundle { name: b.name.clone(), mode: "lacp".into(), members, active_members, ..Default::default() });
        }
        Ok(Response::new(ListBundlesResponse { bundles, ..Default::default() }))
    }

    async fn list_policies(&self, _: Request<ListPoliciesRequest>) -> R<ListPoliciesResponse> {
        let _turno = self.shared.ops.lock().await;
        Ok(Response::new(ListPoliciesResponse { policies: crate::policy::policies(), ..Default::default() }))
    }

    async fn get_policy_counters(&self, req: Request<GetPolicyCountersRequest>) -> R<GetPolicyCountersResponse> {
        let _turno = self.shared.ops.lock().await;
        let uptime = self.shared.state.lock().unwrap().uptime_seconds();
        let uses = crate::policy::counters(&req.into_inner().policy, uptime)?;
        Ok(Response::new(GetPolicyCountersResponse { uses, ..Default::default() }))
    }

    async fn test_policy(&self, req: Request<TestPolicyRequest>) -> R<TestPolicyResponse> {
        let _turno = self.shared.ops.lock().await;
        Ok(Response::new(crate::policy::test(&req.into_inner())?))
    }

    async fn get_logging(&self, _: Request<GetLoggingRequest>) -> R<LoggingState> {
        let st = self.shared.state.lock().unwrap();
        Ok(Response::new(st.logs.state(chrono::Utc::now(), &st.running.log_collectors())))
    }

    async fn show(&self, req: Request<ShowRequest>) -> R<ShowResponse> {
        let _turno = self.shared.ops.lock().await;
        let command = req.into_inner().command;
        // Test hook of the mock only: what the box reports while the
        // dataplane's statistics segment does not answer (#29).
        if let Some(state) = command.trim().strip_prefix("mock log-export ") {
            let stalled = match state {
                "stall" => true,
                "deliver" => false,
                _ => return Err(Status::invalid_argument("mock log-export stall|deliver")),
            };
            if self.shared.state.lock().unwrap().running.log_collectors().syslog.is_none() {
                return Err(Status::failed_precondition("no syslog collector configured (MOCK_LOG_EXPORT, or logging syslog)"));
            }
            self.shared.set_log_stalled(stalled).await;
            return Ok(Response::new(ShowResponse { text: format!("log export {state}\n"), ..Default::default() }));
        }
        if let Some(state) = command.trim().strip_prefix("mock stats-segment ") {
            let up = match state {
                "up" => true,
                "down" => false,
                _ => return Err(Status::invalid_argument("mock stats-segment up|down")),
            };
            self.shared.set_health(up).await;
            return Ok(Response::new(ShowResponse { text: format!("stats segment {state}\n"), ..Default::default() }));
        }
        // Test hook (#77): the dataplane runs the plugin from before the upgrade, or not.
        if let Some(on) = command.trim().strip_prefix("mock transceivers old-plugin ") {
            let on = match on {
                "on" => true,
                "off" => false,
                _ => return Err(Status::invalid_argument("mock transceivers old-plugin on|off")),
            };
            self.shared.state.lock().unwrap().old_plugin = on;
            return Ok(Response::new(ShowResponse { text: format!("old plugin {on}\n"), ..Default::default() }));
        }
        // Test hook (#76): wan0's RX power, in mW (0 is no light).
        if let Some(mw) = command.trim().strip_prefix("mock transceiver wan0 rx ") {
            let mw: f64 = mw.parse().map_err(|_| Status::invalid_argument("mock transceiver wan0 rx <mW>"))?;
            self.shared.state.lock().unwrap().wan0_rx_mw = mw;
            return Ok(Response::new(ShowResponse { text: format!("wan0 rx {mw} mW\n"), ..Default::default() }));
        }
        // Test hook (#75): the dataplane starts now for a cause (`none`: a start not recorded).
        if let Some(cause) = command.trim().strip_prefix("mock dataplane-start ") {
            let cause = match cause {
                "boot" | "operator" | "upgrade" | "unexpected" => cause,
                "none" => "",
                _ => return Err(Status::invalid_argument("mock dataplane-start boot|operator|upgrade|unexpected|none (boot: back to the boot's start)")),
            };
            let mut st = self.shared.state.lock().unwrap();
            match cause {
                // Back to the start the boot brought about: no restart.
                "boot" => st.dataplane_start = None,
                "" => st.dataplane_start = Some((chrono::Utc::now(), String::new())),
                _ => st.dataplane_started_now(cause, ""),
            }
            return Ok(Response::new(ShowResponse { text: format!("dataplane started ({cause})\n"), ..Default::default() }));
        }
        // Test hook (#70): the "boot" leaves a card's statements out, or not.
        if let Some(state) = command.trim().strip_prefix("mock pending ") {
            let pending = match state {
                "on" => Some(PendingConfiguration {
                    pending: true,
                    cards: vec!["wan9".into()],
                    left_out: vec!["interface wan9".into(), " ipv4 address 198.51.100.200/30".into(), " cgnat outside".into(), "exit".into()],
                    since: chrono::Utc::now().timestamp(),
                    path: "/etc/prisma/prisma.conf".into(),
                    held_for_a_commit: false,
                }),
                "off" => None,
                _ => return Err(Status::invalid_argument("mock pending on|off")),
            };
            self.shared.set_pending(pending).await;
            return Ok(Response::new(ShowResponse { text: format!("pending {state}\n"), ..Default::default() }));
        }
        // Test hook (#66): a BFD peer goes down or comes back.
        if let Some(rest) = command.trim().strip_prefix("mock bfd ") {
            let (state, peer) = rest.split_once(' ').unwrap_or((rest, ""));
            let mut st = self.shared.state.lock().unwrap();
            match state {
                "down" => st.bfd_down.insert(peer.to_string()),
                "up" => st.bfd_down.remove(peer),
                _ => return Err(Status::invalid_argument("mock bfd down|up <peer>")),
            };
            return Ok(Response::new(ShowResponse { text: format!("bfd peer {peer} {state}\n"), ..Default::default() }));
        }
        // Test hook: how the next dataplane restart answers: it drops the connection, as on a box
        // whose management address is on a dataplane interface (#51), or answers apply_failed
        // though it ran, as 0.149.32 can (#57).
        if let Some(state) = command.trim().strip_prefix("mock restart-dataplane ") {
            let answer = match state {
                "drops" | "apply-failed" => Some(state.to_string()),
                "answers" => None,
                _ => return Err(Status::invalid_argument("mock restart-dataplane drops|apply-failed|answers")),
            };
            self.shared.state.lock().unwrap().restart_answer = answer;
            return Ok(Response::new(ShowResponse { text: format!("dataplane restart {state}\n"), ..Default::default() }));
        }
        let text = {
            let st = self.shared.state.lock().unwrap();
            self.show(&st, command.trim())?
        };
        // `ping <target> count N` takes as long as a real one (250 ms per packet,
        // up to 120), holding the account's process as on Prisma 0.148.5.
        let words: Vec<&str> = command.split_whitespace().collect();
        if let ["ping", _, "count", n, ..] = words.as_slice() {
            let n: u64 = n.parse().unwrap_or(4).min(120);
            tokio::time::sleep(std::time::Duration::from_millis(250 * n)).await;
        }
        Ok(Response::new(ShowResponse { text, ..Default::default() }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_reports_known_zero_and_vpp_unknown() {
        assert_eq!(speed_bps("wan0"), 10_000_000_000);
        assert_eq!(speed_bps("lan0.20"), 4_294_967_295_000);
        assert_eq!(speed_bps("wg0"), 0);
    }

    #[test]
    fn worker_load_stays_in_the_dataplane_range() {
        let mut st = State::new("prisma-hq", 1.0);
        // The seeded day of history leaves subscribers wherever the curve was; pin the nominal load.
        st.subscribers = 5_500.0;
        let load = worker_load(&st);
        assert_eq!(load.len(), 5);
        for w in &load {
            // VPP's share of node clocks: a saturated worker reads about 0.5, never 1.
            assert!((0.0..=0.52).contains(&w.busy_ratio), "{w:?}");
            assert!(w.vectors_per_call <= 256.0 && w.loops_per_second > 1_000.0, "{w:?}");
        }
        assert!(load[4].busy_ratio > 0.35, "the last worker runs near saturation: {:?}", load[4]);
    }
}
