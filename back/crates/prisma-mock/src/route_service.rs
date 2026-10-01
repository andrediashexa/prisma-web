//! `RouteService` (#533): a typed routing table, paged from snapshots the way
//! Prisma pages zebra's RIB. The table is synthetic and fixed (~11.7k routes
//! in two VRFs and both families), big enough for several pages at the
//! largest page size.

use std::collections::{BTreeMap, HashMap};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::Utc;
use prisma_proto::v1::route_service_server::RouteService;
use prisma_proto::v1::*;
use tonic::{Request, Response, Status};

use crate::state::timestamp;

type R<T> = Result<Response<T>, Status>;

const DEFAULT_PAGE: usize = 1000;
const MAX_PAGE: usize = 5000;
/// Like Prisma: a snapshot nobody pages for 10 minutes is dropped, and a
/// routes process holds four at most, the oldest dropped first.
const SNAPSHOT_IDLE: Duration = Duration::from_secs(600);
const MAX_SNAPSHOTS: usize = 4;
/// The protocol words Prisma 0.149.4 accepts in the filter.
const PROTOCOLS: &[&str] = &[
    "kernel", "connected", "local", "static", "rip", "ripng", "ospf", "ospf6", "isis", "bgp", "pim", "eigrp", "nhrp", "table",
    "babel", "sharp", "openfabric",
];

/// A route with its prefix parsed once, for the prefix filter and the order.
struct Entry {
    route: Route,
    net: u128,
    len: u8,
}

struct Snapshot {
    /// Indexes into `table()` of the routes the filters matched.
    routes: Arc<Vec<usize>>,
    at: prost_types::Timestamp,
    used: Instant,
}

#[derive(Default)]
pub struct RouteSvc {
    snapshots: Mutex<HashMap<u64, Snapshot>>,
    next_id: AtomicU64,
}

/// `(family, network, length)` of "10.0.0.0/8"; a bare address is a host
/// prefix. Host bits are masked off, as zebra does.
fn parse_prefix(s: &str) -> Option<(u32, u128, u8)> {
    let (addr, len) = match s.split_once('/') {
        Some((a, l)) => (a, Some(l.parse::<u8>().ok()?)),
        None => (s, None),
    };
    let (family, bits, raw) = match addr.parse::<IpAddr>().ok()? {
        IpAddr::V4(a) => (4, 32u8, u128::from(u32::from(a))),
        IpAddr::V6(a) => (6, 128u8, u128::from(a)),
    };
    let len = len.unwrap_or(bits);
    if len > bits {
        return None;
    }
    Some((family, raw & mask(len, bits), len))
}

fn mask(len: u8, bits: u8) -> u128 {
    let full = if bits == 128 { u128::MAX } else { (1u128 << bits) - 1 };
    if len == 0 { 0 } else { (full << (bits - len)) & full }
}

fn via(address: &str, interface: &str) -> RouteNextHop {
    RouteNextHop { address: address.into(), interface: interface.into(), active: true, fib: true, weight: 1, ..Default::default() }
}

fn direct(interface: &str) -> RouteNextHop {
    RouteNextHop { interface: interface.into(), active: true, fib: true, weight: 1, directly_connected: true, ..Default::default() }
}

fn blackhole() -> RouteNextHop {
    RouteNextHop { active: true, fib: true, blackhole: "blackhole".into(), ..Default::default() }
}

/// A route that lost to another protocol: usable, but not in the FIB.
fn standby(mut nh: RouteNextHop) -> RouteNextHop {
    nh.fib = false;
    nh
}

#[derive(Default)]
struct Table(Vec<Entry>);

impl Table {
    #[allow(clippy::too_many_arguments)]
    fn push(&mut self, vrf: &str, prefix: &str, protocol: &str, distance: u32, metric: u32, selected: bool, next_hops: Vec<RouteNextHop>, age: u64) {
        let (family, net, len) = parse_prefix(prefix).expect("mock prefix");
        let next_hops = if selected { next_hops } else { next_hops.into_iter().map(standby).collect() };
        self.0.push(Entry {
            route: Route {
                vrf: vrf.into(),
                prefix: prefix.into(),
                family,
                protocol: protocol.into(),
                distance,
                metric,
                selected,
                installed: selected,
                next_hops,
                table: if vrf == "default" { 254 } else { 1001 },
                age_seconds: age,
                ..Default::default()
            },
            net,
            len,
        });
    }
}

/// The synthetic table, in FRR's order: `default` first, then by family and
/// prefix, the selected route of a prefix before the others.
fn table() -> &'static [Entry] {
    static TABLE: OnceLock<Vec<Entry>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut t = Table::default();
        let up = 3 * 86_400 + 7_342;
        let d = "default";

        t.push(d, "0.0.0.0/0", "bgp", 20, 0, true, vec![via("203.0.113.9", "wan0")], up);
        t.push(d, "203.0.113.8/29", "connected", 0, 0, true, vec![direct("wan0")], up);
        t.push(d, "203.0.113.10/32", "local", 0, 0, true, vec![direct("wan0")], up);
        t.push(d, "192.168.10.0/24", "connected", 0, 0, true, vec![direct("lan0")], up);
        t.push(d, "192.168.10.0/24", "ospf", 110, 10, false, vec![direct("lan0")], up);
        t.push(d, "192.168.10.1/32", "local", 0, 0, true, vec![direct("lan0")], up);
        t.push(d, "192.168.20.0/24", "connected", 0, 0, true, vec![direct("lan0.20")], up);
        t.push(d, "192.168.20.1/32", "local", 0, 0, true, vec![direct("lan0.20")], up);
        // The CGNAT pool is announced from a blackhole.
        t.push(d, "100.64.0.0/10", "static", 1, 0, true, vec![blackhole()], up);
        t.push(d, "198.51.100.0/24", "static", 1, 0, true, vec![via("192.168.10.2", "lan0")], up);
        for i in 0..40u32 {
            t.push(d, &format!("10.20.{i}.0/24"), "ospf", 110, 10 + i, true, vec![via("192.168.10.2", "lan0")], 86_400 + u64::from(i) * 60);
        }
        for i in 0..8000u32 {
            let p = format!("{}/24", std::net::Ipv4Addr::from(0x1700_0000 + (i << 8)));
            t.push(d, &p, "bgp", 20, 0, true, vec![via("203.0.113.9", "wan0")], up - u64::from(i % 3600));
            // Every 25th prefix also has a floating static that BGP beats.
            if i % 25 == 0 {
                t.push(d, &p, "static", 250, 0, false, vec![via("192.168.10.2", "lan0")], up);
            }
        }

        t.push(d, "::/0", "bgp", 20, 0, true, vec![via("fe80::1", "wan0")], up);
        t.push(d, "2001:db8:100::/64", "connected", 0, 0, true, vec![direct("wan0")], up);
        t.push(d, "2001:db8:100::2/128", "local", 0, 0, true, vec![direct("wan0")], up);
        t.push(d, "2001:db8:200:10::/64", "connected", 0, 0, true, vec![direct("lan0")], up);
        t.push(d, "2001:db8:200:10::1/128", "local", 0, 0, true, vec![direct("lan0")], up);
        t.push(d, "2001:db8:ffff::/48", "static", 1, 0, true, vec![blackhole()], up);
        for i in 0..30u32 {
            t.push(d, &format!("2001:db8:300:{i:x}::/64"), "ospf6", 110, 20 + i, true, vec![via("fe80::2", "lan0")], 86_400);
        }
        for i in 0..2500u32 {
            t.push(d, &format!("2001:db8:{:x}::/48", 0x1000 + i), "bgp", 20, 0, true, vec![via("fe80::1", "wan0")], up - u64::from(i % 3600));
        }

        let red = "red";
        // A route leaked from default: its next hop is in the other VRF.
        let mut leaked = via("203.0.113.9", "wan0");
        leaked.vrf = d.into();
        t.push(red, "0.0.0.0/0", "static", 1, 0, true, vec![leaked], up);
        t.push(red, "10.100.0.0/24", "connected", 0, 0, true, vec![direct("red0")], up);
        t.push(red, "10.100.0.1/32", "local", 0, 0, true, vec![direct("red0")], up);
        for i in 0..600u32 {
            let p = format!("{}/24", std::net::Ipv4Addr::from(0xac10_0000 + (i << 8)));
            t.push(red, &p, "bgp", 200, 0, true, vec![via("10.100.0.2", "red0")], up - u64::from(i));
        }
        t.push(red, "2001:db8:a00::/64", "connected", 0, 0, true, vec![direct("red0")], up);
        for i in 0..200u32 {
            t.push(red, &format!("2001:db8:b{i:03x}::/48"), "bgp", 200, 0, true, vec![via("2001:db8:a00::2", "red0")], up);
        }

        let mut v = t.0;
        v.sort_by_key(|e| (e.route.vrf != "default", e.route.vrf.clone(), e.route.family, e.net, e.len, !e.route.selected));
        v
    })
}

fn matches(e: &Entry, q: &ListRoutesRequest, prefix: Option<(u32, u128, u8)>) -> bool {
    let r = &e.route;
    (q.vrf.is_empty() || r.vrf == q.vrf)
        && (q.family == 0 || r.family == q.family)
        && (q.protocol.is_empty() || r.protocol == q.protocol)
        && (!q.selected_only || r.selected)
        && prefix.is_none_or(|(family, net, len)| {
            let bits = if family == 4 { 32 } else { 128 };
            r.family == family && e.len >= len && e.net & mask(len, bits) == net
        })
}

impl RouteSvc {
    /// Starts a snapshot from the filters, or finds the one a token continues.
    fn snapshot(&self, q: &ListRoutesRequest) -> Result<(u64, usize, Arc<Vec<usize>>, prost_types::Timestamp), Status> {
        let mut snaps = self.snapshots.lock().unwrap();
        snaps.retain(|_, s| s.used.elapsed() < SNAPSHOT_IDLE);
        if !q.page_token.is_empty() {
            // Prisma 0.149.4 answers a malformed token like an expired one.
            let gone = || Status::failed_precondition("the page token names no snapshot this box still holds; start again without one");
            let (id, offset) = q
                .page_token
                .split_once('.')
                .and_then(|(i, o)| Some((i.parse::<u64>().ok()?, o.parse::<usize>().ok()?)))
                .ok_or_else(gone)?;
            let s = snaps.get_mut(&id).ok_or_else(gone)?;
            s.used = Instant::now();
            return Ok((id, offset.min(s.routes.len()), s.routes.clone(), s.at));
        }
        if !matches!(q.family, 0 | 4 | 6) {
            return Err(Status::invalid_argument("family must be 4, 6 or 0"));
        }
        // As Prisma 0.149.4 answers them, measured on the lab box.
        if !q.vrf.is_empty() && !table().iter().any(|e| e.route.vrf == q.vrf) {
            return Err(Status::not_found(format!("no VRF {}", q.vrf)));
        }
        if !q.protocol.is_empty() && !PROTOCOLS.contains(&q.protocol.as_str()) {
            return Err(Status::invalid_argument(format!("'{}' is not a protocol FRR names; one of {}", q.protocol, PROTOCOLS.join(", "))));
        }
        let prefix = match q.prefix.trim() {
            "" => None,
            p => Some(parse_prefix(p).ok_or_else(|| Status::invalid_argument(format!("{p} is not a prefix")))?),
        };
        let routes: Vec<usize> = table().iter().enumerate().filter(|(_, e)| matches(e, q, prefix)).map(|(i, _)| i).collect();
        while snaps.len() >= MAX_SNAPSHOTS {
            let oldest = *snaps.keys().min().unwrap();
            snaps.remove(&oldest);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let s = Snapshot { routes: Arc::new(routes), at: timestamp(Utc::now()), used: Instant::now() };
        let out = (id, 0, s.routes.clone(), s.at);
        snaps.insert(id, s);
        Ok(out)
    }
}

#[tonic::async_trait]
impl RouteService for RouteSvc {
    async fn list_routes(&self, req: Request<ListRoutesRequest>) -> R<ListRoutesResponse> {
        let q = req.into_inner();
        let size = match q.page_size as usize {
            0 => DEFAULT_PAGE,
            n => n.min(MAX_PAGE),
        };
        let first = q.page_token.is_empty();
        let (id, offset, routes, at) = self.snapshot(&q)?;
        let end = (offset + size).min(routes.len());
        let all = table();
        let page = routes[offset..end].iter().map(|&i| all[i].route.clone()).collect();
        let last = end == routes.len();
        // Prisma answers the first page while it still reads the rest, so a
        // first page with more behind it does not know the total yet.
        let total_known = last || !first;
        Ok(Response::new(ListRoutesResponse {
            routes: page,
            next_page_token: if last { String::new() } else { format!("{id}.{end}") },
            total: if total_known { routes.len() as u64 } else { 0 },
            total_known,
            snapshot_at: Some(at),
            ..Default::default()
        }))
    }

    async fn get_route_summary(&self, req: Request<GetRouteSummaryRequest>) -> R<GetRouteSummaryResponse> {
        let vrf = req.into_inner().vrf;
        let mut counts: BTreeMap<(bool, String, u32, String), (u64, u64)> = BTreeMap::new();
        for r in table().iter().map(|e| &e.route).filter(|r| vrf.is_empty() || r.vrf == vrf) {
            let c = counts.entry((r.vrf != "default", r.vrf.clone(), r.family, r.protocol.clone())).or_default();
            c.0 += 1;
            c.1 += u64::from(r.installed);
        }
        let counts = counts
            .into_iter()
            .map(|((_, vrf, family, protocol), (rib, fib))| RouteCount { vrf, family, protocol, rib, fib, ..Default::default() })
            .collect();
        Ok(Response::new(GetRouteSummaryResponse { counts, ..Default::default() }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn list(svc: &RouteSvc, q: ListRoutesRequest) -> Result<ListRoutesResponse, Status> {
        svc.list_routes(Request::new(q)).await.map(Response::into_inner)
    }

    fn page(token: &str, size: u32) -> ListRoutesRequest {
        ListRoutesRequest { page_token: token.into(), page_size: size, ..Default::default() }
    }

    #[tokio::test]
    async fn pages_through_one_snapshot() {
        let svc = RouteSvc::default();
        let total = table().len();
        assert!(total > 2 * MAX_PAGE, "the table must span several pages: {total}");
        let first = list(&svc, page("", 5000)).await.unwrap();
        assert_eq!(first.routes.len(), 5000);
        assert!(!first.total_known && first.total == 0, "the first page does not know the total");
        assert!(first.snapshot_at.is_some());
        let mut seen = first.routes.len();
        let mut token = first.next_page_token;
        let mut last = None;
        while !token.is_empty() {
            let p = list(&svc, page(&token, 5000)).await.unwrap();
            assert!(p.total_known && p.total == total as u64);
            assert_eq!(p.snapshot_at, first.snapshot_at);
            seen += p.routes.len();
            token = p.next_page_token.clone();
            last = Some(p);
        }
        assert_eq!(seen, total);
        assert_eq!(last.unwrap().routes.last().unwrap().vrf, "red", "default comes first");
    }

    #[tokio::test]
    async fn page_size_defaults_and_is_capped() {
        let svc = RouteSvc::default();
        assert_eq!(list(&svc, page("", 0)).await.unwrap().routes.len(), DEFAULT_PAGE);
        assert_eq!(list(&svc, page("", 9999)).await.unwrap().routes.len(), MAX_PAGE);
    }

    #[tokio::test]
    async fn filters_and_a_token_keeps_the_snapshots_filters() {
        let svc = RouteSvc::default();
        let q = ListRoutesRequest { vrf: "red".into(), family: 6, protocol: "bgp".into(), page_size: 150, ..Default::default() };
        let p1 = list(&svc, q).await.unwrap();
        assert!(!p1.total_known);
        // The token ignores the filters it is sent with.
        let p2 = list(&svc, ListRoutesRequest { family: 4, ..page(&p1.next_page_token, 150) }).await.unwrap();
        assert_eq!((p2.total, p2.next_page_token.as_str()), (200, ""));
        for r in p1.routes.iter().chain(&p2.routes) {
            assert_eq!((r.vrf.as_str(), r.family, r.protocol.as_str()), ("red", 6, "bgp"));
        }

        // A prefix and the ones inside it: 256 BGP /24s and 11 floating statics.
        let q = ListRoutesRequest { prefix: "23.0.0.0/16".into(), page_size: 5000, ..Default::default() };
        let all = list(&svc, q.clone()).await.unwrap();
        assert_eq!(all.routes.len(), 267);
        assert!(all.routes.iter().all(|r| r.prefix.starts_with("23.0.")));
        let selected = list(&svc, ListRoutesRequest { selected_only: true, ..q }).await.unwrap();
        assert_eq!(selected.routes.len(), 256);
        assert!(selected.routes.iter().all(|r| r.selected && r.installed && r.protocol == "bgp"));

        let host = list(&svc, ListRoutesRequest { prefix: "203.0.113.10".into(), ..Default::default() }).await.unwrap();
        assert_eq!(host.routes.iter().map(|r| r.protocol.as_str()).collect::<Vec<_>>(), ["local"]);
    }

    #[tokio::test]
    async fn refusals() {
        let svc = RouteSvc::default();
        let code = |r: Result<ListRoutesResponse, Status>| r.unwrap_err().code();
        assert_eq!(code(list(&svc, ListRoutesRequest { family: 5, ..Default::default() }).await), tonic::Code::InvalidArgument);
        assert_eq!(code(list(&svc, ListRoutesRequest { prefix: "10.0.0.0/33".into(), ..Default::default() }).await), tonic::Code::InvalidArgument);
        assert_eq!(code(list(&svc, ListRoutesRequest { vrf: "blue".into(), ..Default::default() }).await), tonic::Code::NotFound);
        assert_eq!(code(list(&svc, ListRoutesRequest { protocol: "egp".into(), ..Default::default() }).await), tonic::Code::InvalidArgument);
        // An unknown protocol word is refused, a known one with no routes is not.
        assert!(list(&svc, ListRoutesRequest { protocol: "isis".into(), ..Default::default() }).await.unwrap().routes.is_empty());
        assert_eq!(code(list(&svc, page("nonsense", 0)).await), tonic::Code::FailedPrecondition);
        assert_eq!(code(list(&svc, page("999.0", 0)).await), tonic::Code::FailedPrecondition);

        // A fifth snapshot drops the oldest one.
        let first = list(&svc, page("", 10)).await.unwrap().next_page_token;
        for _ in 0..MAX_SNAPSHOTS {
            list(&svc, page("", 10)).await.unwrap();
        }
        assert_eq!(code(list(&svc, page(&first, 10)).await), tonic::Code::FailedPrecondition);
    }

    #[tokio::test]
    async fn summary_counts_rib_and_fib() {
        let svc = RouteSvc::default();
        let all = svc.get_route_summary(Request::new(GetRouteSummaryRequest::default())).await.unwrap().into_inner().counts;
        assert_eq!(all.iter().map(|c| c.rib).sum::<u64>(), table().len() as u64);
        let statics = all.iter().find(|c| (c.vrf.as_str(), c.family, c.protocol.as_str()) == ("default", 4, "static")).unwrap();
        // Two installed statics, and 320 floating ones that BGP beats.
        assert_eq!((statics.rib, statics.fib), (322, 2));
        assert_eq!(all[0].vrf, "default");
        let red = svc
            .get_route_summary(Request::new(GetRouteSummaryRequest { vrf: "red".into(), ..Default::default() }))
            .await
            .unwrap()
            .into_inner()
            .counts;
        assert!(!red.is_empty() && red.iter().all(|c| c.vrf == "red"));
    }
}
