//! The rest of the VTY's screens and the probes (Prisma 0.150.6, #64), as the mock
//! answers them.

use std::time::Duration;

use prisma_proto::v1::probe_event::Kind;
use prisma_proto::v1::*;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::codegen::BoxStream;
use tonic::Status;

pub fn ospf_interfaces() -> OspfInterfaces {
    let i = |name: &str, area: &str, state: &str, passive: bool, cost: i32, mtu: u32, dp: u32| OspfInterface {
        name: name.into(),
        area: area.into(),
        state: state.into(),
        passive,
        cost,
        adjacent: if passive { 0 } else { 1 },
        neighbors: if passive { 0 } else { 1 },
        ospf_mtu: mtu,
        dataplane: name.into(),
        dataplane_mtu: dp,
        dataplane_mtu_known: true,
        mtu_stall: mtu != dp,
    };
    let interfaces = vec![i("lan0", "0.0.0.0", "DR", false, 10, 1500, 1500), i("wan0", "0.0.0.0", "Point-To-Point", false, 10, 1500, 9000), i("lan0.20", "0.0.0.0", "DR", true, 10, 1500, 1500)];
    let mut text = String::from("Interface  Area      State           Cost  Nbrs  MTU (ospf/dataplane)\n");
    for x in &interfaces {
        text += &format!("{:<10} {:<9} {:<15} {:>4}  {:>4}  {}/{}{}\n", x.name, x.area, x.state, x.cost, x.neighbors, x.ospf_mtu, x.dataplane_mtu, if x.mtu_stall { "  MTU mismatch" } else { "" });
    }
    OspfInterfaces { answered: true, interfaces, text }
}

pub fn isis_interfaces() -> IsisInterfaces {
    let circuits = vec![IsisInterface { name: "lan0".into(), area: "core".into(), circuit_id: "0x1".into(), state: "Up".into(), level: "L2".into(), metric: 10, active_neighbors: 1, ..Default::default() }];
    IsisInterfaces { answered: true, circuits, punt_known: true, punting: true, osi_drops: 0, text: "Area core:\n  lan0  0x1  Up  L2  metric 10  1 neighbor\nOSI punt: on, 0 drops\n".into() }
}

pub fn hardware() -> Hardware {
    let nic = |name: &str, pci: &str, driver: &str, dpdk: bool, link: &str, speed: u32, mac: &str, default: bool| HardwareNic {
        name: name.into(),
        pci: pci.into(),
        driver: driver.into(),
        dpdk_driver: dpdk,
        link: link.into(),
        speed_mbps: speed,
        mac: mac.into(),
        default_route: default,
    };
    let nics = vec![
        nic("eth0", "0000:00:12.0", "virtio-pci", false, "up", 1000, "02:00:00:00:00:10", true),
        nic("wan0", "0000:00:13.0", "vfio-pci", true, "up", 10000, "02:00:00:00:00:11", false),
        nic("lan0", "0000:00:14.0", "vfio-pci", true, "up", 10000, "02:00:00:00:00:12", false),
    ];
    let mut text = String::from("NIC   PCI           Driver      Link  Speed  MAC\n");
    for n in &nics {
        text += &format!("{:<5} {:<13} {:<11} {:<5} {:>5}  {}{}\n", n.name, n.pci, n.driver, n.link, n.speed_mbps, n.mac, if n.default_route { "  (default route)" } else { "" });
    }
    Hardware { dataplane_answered: true, dataplane_holds: vec!["wan0".into(), "lan0".into()], nics, default_route_interface: "eth0".into(), text }
}

pub fn routing_logging() -> RoutingLogging {
    let d = |daemon: &str| DaemonLogging {
        daemon: daemon.into(),
        syslog: Some(LoggingTarget { enabled: true, level: "informational".into(), facility: "daemon".into(), ident: daemon.into(), ..Default::default() }),
        stdout: Some(LoggingTarget { enabled: false, ..Default::default() }),
        file: Some(LoggingTarget { enabled: false, ..Default::default() }),
        protocol: "syslog".into(),
        record_priority: false,
        record_severity: false,
        timestamp_precision: 0,
    };
    let daemons = vec![d("bgpd"), d("ospfd"), d("zebra")];
    let text = daemons.iter().map(|d| format!("{}: syslog informational (facility daemon)\n", d.daemon)).collect();
    RoutingLogging { daemons, text }
}

pub fn snmp_file(kind: i32) -> Result<SnmpFile, Status> {
    use get_snmp_file_request::Kind as K;
    match K::try_from(kind).unwrap_or(K::Unspecified) {
        K::Mib => Ok(SnmpFile {
            filename: "PRISMA-MIB.txt".into(),
            media_type: "text/plain".into(),
            enterprise_number: "67033".into(),
            content: "PRISMA-MIB DEFINITIONS ::= BEGIN\n-- enterprise 67033 (mock)\nEND\n".into(),
        }),
        K::ZabbixTemplate => Ok(SnmpFile {
            filename: "prisma-zabbix-7.0.yaml".into(),
            media_type: "application/yaml".into(),
            enterprise_number: "67033".into(),
            content: "zabbix_export:\n  version: '7.0'\n  templates:\n    - template: Prisma (mock)\n      macros:\n        - macro: '{$PRISMA.ENTERPRISE}'\n          value: '67033'\n".into(),
        }),
        K::Unspecified => Err(Status::invalid_argument("% which file: mib or zabbix-template")),
    }
}

/// `ping`, `traceroute`, `mtr` as the box streams them: a line at a time, then `end`.
pub fn probe(tool: &'static str, req: ProbeRequest) -> Result<BoxStream<ProbeEvent>, Status> {
    let host = req.host.trim().to_string();
    if host.is_empty() || host.contains(char::is_whitespace) || host.contains(';') {
        return Err(Status::invalid_argument(format!("% Unknown host {host}")));
    }
    let count = if req.count == 0 { 5 } else { req.count.min(100) };
    let (tx, rx) = mpsc::channel(16);
    tokio::spawn(async move {
        let send = |e: ProbeEvent| {
            let tx = tx.clone();
            async move { tx.send(Ok(e)).await.is_ok() }
        };
        match tool {
            "ping" => {
                if !send(ProbeEvent { line: format!("PING {host} 56(84) bytes of data."), kind: None }).await {
                    return;
                }
                for n in 1..=count {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    let rtt = 0.3 + f64::from(n) * 0.01;
                    let e = ProbeEvent {
                        line: format!("64 bytes from {host}: icmp_seq={n} ttl=64 time={rtt:.2} ms"),
                        kind: Some(Kind::Reply(PingReply { sequence: n, from_address: host.clone(), ttl: 64, rtt_ms: rtt })),
                    };
                    if !send(e).await {
                        return;
                    }
                }
                let end = ProbeEnd { transmitted: count, received: count, rtt_known: true, rtt_min_ms: 0.31, rtt_avg_ms: 0.33, rtt_max_ms: 0.35, ..Default::default() };
                send(ProbeEvent { line: format!("{count} packets transmitted, {count} received, 0% packet loss"), kind: Some(Kind::End(end)) }).await;
            }
            "traceroute" => {
                for hop in 1..=3u32 {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    let address = if hop == 3 { host.clone() } else { format!("192.0.2.{hop}") };
                    let e = ProbeEvent { line: format!(" {hop}  {address}  {:.3} ms", f64::from(hop) * 0.5), kind: Some(Kind::Hop(TraceHop { hop, address, answered: true, rtt_ms: f64::from(hop) * 0.5 })) };
                    if !send(e).await {
                        return;
                    }
                }
                send(ProbeEvent { line: String::new(), kind: Some(Kind::End(ProbeEnd::default())) }).await;
            }
            _ => {
                tokio::time::sleep(Duration::from_millis(400)).await;
                for hop in 1..=2u32 {
                    let address = if hop == 2 { host.clone() } else { "192.0.2.1".into() };
                    let h = MtrHop { hop, address: address.clone(), answered: true, sent: count, last_ms: 0.4, avg_ms: 0.4, best_ms: 0.3, worst_ms: 0.6, ..Default::default() };
                    if !send(ProbeEvent { line: format!("{hop}.|-- {address}  0.0%  {count}  0.4"), kind: Some(Kind::MtrHop(h)) }).await {
                        return;
                    }
                }
                send(ProbeEvent { line: String::new(), kind: Some(Kind::End(ProbeEnd::default())) }).await;
            }
        }
    });
    Ok(Box::pin(ReceiverStream::new(rx)))
}
